import { PackagingJobsDatabase } from "../db/packaging-jobs";
import { dispatchPackagingJob, type PackagingJob } from "../packages/jobs";
import { sha256 } from "@fossbilling/extension-packaging/checksum";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { getAuth } from "../../../../lib/auth/index";
import { getPlatform } from "../../../../lib/middleware";
import { canonicalJson } from "../packages/manifest";
import type { ArtifactRow } from "../packages/repository";
import { PackageBuildDatabase } from "../db/package-builds";
import {
  requireContentWrite,
  getPublisher,
  requireModerator,
  optionalAuth,
  getOptionalAuth,
  paceContentAccount,
  paceContentIp
} from "../middleware";
import { reserveObject, cleanupPackageObjects } from "../packages/build";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import { boundedBytes } from "@fossbilling/extension-packaging/store";
import { packageStore } from "../packages/store";
import { ManifestSchema } from "../schemas/manifest";
import {
  PackageArtifactSchema,
  PackagingJobSchema,
  PackagingJobParamSchema,
  PackageBuildSchema,
  PackageParamSchema
} from "../schemas/packages";
import { errorResponse, authErrorResponses } from "../schemas/common";
import { ExtensionsV2App } from "./app";

function failure(c: Context, error: unknown) {
  if (error instanceof PackageError)
    return c.json(
      { error: { code: error.code, message: error.message } },
      error.status
    );
  console.error("[packages] Package operation failed");
  return c.json(
    {
      error: {
        code: "PACKAGE_UNAVAILABLE",
        message: "Package storage is temporarily unavailable; retry the request"
      }
    },
    503
  );
}
function artifactResponse(row: ArtifactRow) {
  return {
    result: {
      id: row.id,
      source_id: row.source_id,
      manifest: ManifestSchema.parse(JSON.parse(row.manifest)),
      sha256: row.sha256,
      download_url: row.download_url,
      published_at: row.published_at,
      created_at: row.created_at
    }
  };
}
async function jobResponse(db: D1Database, job: PackagingJob) {
  const artifact = job.artifactId
    ? await new PackageBuildDatabase(db).getArtifact(job.artifactId)
    : null;
  return {
    result: {
      id: job.id,
      extension_identifier: job.manifest.id,
      status: job.status,
      artifact: artifact ? artifactResponse(artifact).result : null,
      error: job.status === "failed" ? job.error : null,
      created_at: job.createdAt,
      updated_at: job.updatedAt
    }
  };
}

const packageErrors = {
  ...authErrorResponses(),
  404: errorResponse("Package not found"),
  409: errorResponse(
    "Source version conflict, ownership changed, or storage quota exhausted"
  ),
  413: errorResponse("Upload exceeds size limit"),
  422: errorResponse("Invalid manifest or source ZIP"),
  429: errorResponse("Write allowance exhausted"),
  503: errorResponse("Package storage is not configured or is unavailable")
};

export function registerPackageRoutes(app: ExtensionsV2App) {
  const availability: MiddlewareHandler<{
    Bindings: CloudflareBindings;
  }> = async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Vary", "Authorization");
    try {
      if (!packageStore(c))
        throw new PackageError(
          "PACKAGES_DISABLED",
          "Package storage is not configured",
          503
        );
    } catch (error) {
      return failure(c, error);
    }
    await next();
  };
  app.use("/packages", availability);
  app.use("/packages/*", availability);
  app.use("/packaging-jobs/*", availability);
  app.on("POST", "/packages", paceContentIp());
  const boundUpload: MiddlewareHandler = async (c, next) => {
    try {
      const body = await boundedBytes(c.req.raw.body, 6 * 1024 * 1024);
      c.req.raw = new Request(c.req.raw, { body });
    } catch (error) {
      return failure(c, error);
    }
    await next();
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/packages",
      tags: ["Packages"],
      summary:
        "Queue package preparation from a distribution ZIP or stored source",
      security: [{ Bearer: [] }],
      middleware: [
        requireContentWrite(),
        paceContentAccount(),
        boundUpload
      ] as const,
      request: {
        body: {
          required: true,
          content: { "multipart/form-data": { schema: PackageBuildSchema } }
        }
      },
      responses: {
        202: {
          description:
            "Private processing job; identical requests reuse queued or completed work",
          content: {
            "application/json": {
              schema: z.object({ result: PackagingJobSchema })
            }
          }
        },
        ...packageErrors
      }
    }),
    async (c) => {
      try {
        const store = packageStore(c)!;
        const form = c.req.valid("form");
        let json: unknown;
        try {
          json = JSON.parse(form.manifest);
        } catch {
          throw new PackageError(
            "INVALID_MANIFEST",
            "Manifest must be valid JSON",
            422
          );
        }
        const parsed = ManifestSchema.safeParse(json);
        if (!parsed.success)
          throw new PackageError(
            "INVALID_MANIFEST",
            "Manifest failed validation",
            422
          );
        const manifest = parsed.data;
        if (form.source && form.source.size > 5 * 1024 * 1024)
          throw new PackageError(
            "BODY_TOO_LARGE",
            "Source ZIP exceeds 5 MiB",
            413
          );
        const db = c.env.DB_EXTENSIONS;
        const repository = new PackageBuildDatabase(db);
        const publisher = getPublisher(c);
        let ownerUserId = getAuth(c).userId;
        // Moderator corrections can rebuild published source, but cannot upload new files for another developer.
        if (form.source_id && !publisher) {
          const correction = await repository.correctionOwner(
            ownerUserId,
            form.source_id,
            manifest
          );
          if (correction) ownerUserId = correction.owner_user_id;
        }
        const owner = await repository.getOwner(
          ownerUserId,
          manifest.id,
          publisher
        );
        const baseUrl = getPlatform(c).getEnv("EXTENSION_PACKAGES_BASE_URL");
        if (!baseUrl)
          throw new PackageError(
            "PACKAGES_DISABLED",
            "Package download URL is not configured",
            503
          );
        const jobs = new PackagingJobsDatabase(db);
        const source = form.source
          ? new Uint8Array(await form.source.arrayBuffer())
          : undefined;
        const uploadSha256 = source ? await sha256(source) : null;
        const fingerprint = await sha256(
          new Uint8Array(
            new TextEncoder().encode(
              canonicalJson({
                owner,
                manifest,
                source: uploadSha256 ?? form.source_id
              })
            )
          )
        );
        let job = await jobs.find(fingerprint);
        if (!job) {
          const uploadObjectId = source
            ? await reserveObject(
                repository,
                store,
                owner,
                manifest.id,
                source,
                uploadSha256!
              )
            : null;
          job = await jobs.create({
            fingerprint,
            owner,
            manifest,
            sourceId: form.source_id ?? null,
            uploadObjectId,
            uploadSha256
          });
        }
        if (job.status === "queued")
          await dispatchPackagingJob(
            jobs,
            getPlatform(c).getQueue("EXTENSION_PACKAGE_QUEUE"),
            job.id
          );
        c.header(
          "Location",
          `${baseUrl.replace(/\/$/, "")}/packaging-jobs/${job.id}`
        );
        c.header("Retry-After", "1");
        return c.json(await jobResponse(db, job), 202);
      } catch (error) {
        return failure(c, error);
      }
    }
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/packaging-jobs/{jobId}",
      tags: ["Packages"],
      summary: "Read an owning developer's private packaging job",
      security: [{ Bearer: [] }],
      middleware: [requireContentWrite()] as const,
      request: { params: PackagingJobParamSchema },
      responses: {
        200: {
          description: "Package processing state and completed artifact",
          content: {
            "application/json": {
              schema: z.object({ result: PackagingJobSchema })
            }
          }
        },
        ...packageErrors
      }
    }),
    async (c) => {
      try {
        const db = c.env.DB_EXTENSIONS;
        const repository = new PackageBuildDatabase(db);
        const job = await new PackagingJobsDatabase(db).get(
          c.req.valid("param").jobId
        );
        if (!job)
          throw new PackageError("NOT_FOUND", "Packaging job not found", 404);
        const userId = getAuth(c).userId;
        const moderator = await repository.isModerator(userId);
        if (!moderator) {
          const publisher = getPublisher(c);
          const owner = await repository.getOwner(
            userId,
            job.manifest.id,
            publisher
          );
          if (
            owner.id !== job.owner.id ||
            owner.profile_generation !== job.owner.profile_generation ||
            owner.ownership_epoch !== job.owner.ownership_epoch ||
            (publisher && publisher.clientId !== job.owner.publisher_client_id)
          )
            throw new PackageError("NOT_FOUND", "Packaging job not found", 404);
        }
        return c.json(await jobResponse(db, job), 200);
      } catch (error) {
        return failure(c, error);
      }
    }
  );

  // Registered before the parameter read. This only reclaims failed uploads;
  // source/package rows and every published artifact remain immutable.
  app.openapi(
    createRoute({
      method: "post",
      path: "/packages/cleanup",
      tags: ["Packages"],
      summary: "Reclaim abandoned local package objects older than one day",
      security: [{ Bearer: [] }],
      middleware: [requireModerator()] as const,
      responses: {
        200: {
          description: "Cleanup completed",
          content: {
            "application/json": {
              schema: z.object({ result: z.object({ deleted: z.number() }) })
            }
          }
        },
        ...packageErrors
      }
    }),
    async (c) => {
      try {
        await new PackagingJobsDatabase(c.env.DB_EXTENSIONS).expire();
        return c.json(
          {
            result: {
              deleted: await cleanupPackageObjects(
                new PackageBuildDatabase(c.env.DB_EXTENSIONS),
                packageStore(c)!
              )
            }
          },
          200
        );
      } catch (error) {
        return failure(c, error);
      }
    }
  );

  for (const resource of ["metadata", "download", "icon"] as const) {
    const download = resource === "download";
    const icon = resource === "icon";
    app.openapi(
      createRoute({
        method: "get",
        path: icon
          ? "/packages/{packageId}/icon"
          : download
            ? "/packages/{packageId}/download"
            : "/packages/{packageId}",
        tags: ["Packages"],
        summary: download
          ? "Download an approved package, or preview as owner/moderator"
          : "Read an approved package or an authorized private preview",
        security: [{ Bearer: [] }],
        middleware: [optionalAuth()] as const,
        request: { params: PackageParamSchema },
        responses: {
          200:
            download || icon
              ? {
                  description: icon
                    ? "Sanitized SVG, optimized AVIF/PNG, or generic fallback"
                    : "Verified immutable ZIP",
                  content: icon
                    ? {
                        "image/svg+xml": {
                          schema: z.string().openapi({ format: "binary" })
                        },
                        "image/png": {
                          schema: z.string().openapi({ format: "binary" })
                        },
                        "image/avif": {
                          schema: z.string().openapi({ format: "binary" })
                        }
                      }
                    : {
                        "application/zip": {
                          schema: z.string().openapi({ format: "binary" })
                        }
                      }
                }
              : {
                  description: "Package manifest and checksum",
                  content: {
                    "application/json": {
                      schema: z.object({ result: PackageArtifactSchema })
                    }
                  }
                },
          ...packageErrors
        }
      }),
      async (c: Context<{ Bindings: CloudflareBindings }>) => {
        try {
          const auth = getOptionalAuth(c);
          const row = await new PackageBuildDatabase(
            c.env.DB_EXTENSIONS
          ).getArtifactForReader(c.req.param("packageId")!, auth?.userId ?? "");
          if (!row)
            throw new PackageError("NOT_FOUND", "Package not found", 404);
          if (!download && !icon) return c.json(artifactResponse(row), 200);
          if (icon) {
            const avif = (c.req.header("Accept") ?? "")
              .split(",")
              .some((part) => {
                const [type, ...params] = part.trim().split(";");
                return (
                  type === "image/avif" &&
                  !params.some((param) => /^\s*q=0(?:\.0*)?\s*$/.test(param))
                );
              });
            if (!row.icon_source_id)
              throw new PackageError(
                "ICON_UNAVAILABLE",
                "Package icon has not been prepared",
                503
              );
            const key =
              row.svg_object_id ??
              (avif ? row.avif_object_id : row.png_object_id);
            const checksum = row.svg_object_id
              ? row.svg_sha256
              : avif
                ? row.avif_sha256
                : row.png_sha256;
            const fallback =
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#a3a3a3" stroke-width="1.5"><path d="m12 3 9 5v8l-9 5-9-5V8Zm0 10L3 8m9 5 9-5m-9 5v8"/></svg>';
            const body = key
              ? await packageStore(c)!.get(key, checksum!)
              : fallback;
            if (!body)
              throw new PackageError(
                "ICON_UNAVAILABLE",
                "Stored icon is unavailable",
                503
              );

            return new Response(body, {
              headers: {
                "Content-Type": row.svg_object_id
                  ? "image/svg+xml"
                  : key
                    ? avif
                      ? "image/avif"
                      : "image/png"
                    : "image/svg+xml",
                "Content-Security-Policy":
                  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, no-store",
                Vary: "Authorization, Accept"
              }
            });
          }
          const body = await packageStore(c)!.get(row.object_id, row.sha256);
          if (!body)
            throw new PackageError(
              "PACKAGE_UNAVAILABLE",
              "Package object is unavailable",
              503
            );
          return new Response(body, {
            headers: {
              "Content-Type": "application/zip",
              "Content-Disposition": `attachment; filename="${row.extension_identifier}-${row.version}-${row.id}.zip"`,
              ETag: `"${row.sha256}"`,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, no-store",
              Vary: "Authorization"
            }
          });
        } catch (error) {
          return failure(c, error);
        }
      }
    );
  }
}
