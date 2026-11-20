import { configuredPackageProcessor } from "../packages/processor";
import { PackagingJobsDatabase } from "../db/packaging-jobs";
import type { PackagingJob } from "../packages/jobs";
import { packageDispatcher } from "../../../../lib/adapters/cloudflare/package-dispatcher";
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
  paceContentIp,
  boundContentRequest
} from "../middleware";
import { cleanupPackageObjects } from "../packages/build";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import { PACKAGE_LIMITS } from "@fossbilling/extension-packaging/limits";
import { packageStore } from "../packages/store";
import type { PackageTarget } from "@fossbilling/extension-packaging/processor";
import { ManifestSchema } from "../schemas/manifest";
import type { PackageOwner } from "../packages/repository";
import {
  PackageArtifactSchema,
  PackagingJobSchema,
  PackagingJobParamSchema,
  PackageBuildSchema,
  PackageReservationSchema,
  PackageUploadRequestSchema,
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
      extension_identifier:
        artifact?.extension_identifier ?? job.target.id ?? null,
      status: job.status,
      artifact: artifact ? artifactResponse(artifact).result : null,
      error: job.status === "failed" ? job.error : null,
      created_at: job.createdAt,
      updated_at: job.updatedAt
    }
  };
}

const uploadLifetimeSeconds = 300;

async function packageFingerprint(
  owner: PackageOwner,
  target: PackageTarget,
  source: string
) {
  return sha256(
    new Uint8Array(
      new TextEncoder().encode(canonicalJson({ owner, target, source }))
    )
  );
}

const packageErrors = {
  ...authErrorResponses(),
  404: errorResponse("Package not found"),
  409: errorResponse(
    "A published release is locked, ownership changed, or storage quota is exhausted"
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
  app.use("/package-uploads", availability);
  app.use("/packages/*", availability);
  app.use("/packaging-jobs/*", availability);
  app.on(
    "POST",
    ["/packages", "/package-uploads"],
    async (c, next) => {
      try {
        configuredPackageProcessor(getPlatform(c).getEnv);
      } catch (error) {
        return failure(c, error);
      }
      await next();
    },
    paceContentIp()
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/package-uploads",
      tags: ["Packages"],
      summary: "Reserve a private source ZIP upload or reuse an existing job",
      security: [{ Bearer: [] }],
      middleware: [
        requireContentWrite(),
        paceContentAccount(),
        boundContentRequest()
      ] as const,
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: PackageUploadRequestSchema }
          }
        }
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ result: PackageReservationSchema })
            }
          },
          description:
            "A short-lived PUT URL and required headers, or an existing job"
        },
        ...packageErrors
      }
    }),
    async (c) => {
      try {
        const { target, bytes, sha256: checksum } = c.req.valid("json");
        if (bytes > PACKAGE_LIMITS.sourceBytes)
          throw new PackageError(
            "BODY_TOO_LARGE",
            "Source ZIP exceeds 5 MiB",
            413
          );
        const db = c.env.DB_EXTENSIONS;
        const repository = new PackageBuildDatabase(db);
        const owner = await repository.getOwner(
          getAuth(c).userId,
          target.id ?? null,
          getPublisher(c)
        );
        const dispatcher = packageDispatcher(c.env);
        const scope = await dispatcher.scope();
        const fingerprint = await packageFingerprint(owner, target, checksum);
        const existing = await new PackagingJobsDatabase(db, scope).find(
          fingerprint
        );
        if (existing) {
          if (existing.status === "queued") await dispatcher.wake(true);
          const { result: job } = await jobResponse(db, existing);
          return c.json({ result: { kind: "job" as const, job } }, 200);
        }
        const now = Math.floor(Date.now() / 1000);
        const { id, expires_at: expiresAt } = await repository.reserveUpload(
          owner,
          target,
          {
            scope,
            fingerprint,
            bytes,
            sha256: checksum,
            now,
            expiresAt: now + uploadLifetimeSeconds
          }
        );
        const upload = await packageStore(c)!.authorizeUpload(
          id,
          bytes,
          checksum,
          expiresAt
        );
        return c.json(
          { result: { kind: "upload" as const, id, ...upload } },
          200
        );
      } catch (error) {
        return failure(c, error);
      }
    }
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/packages",
      tags: ["Packages"],
      summary: "Confirm an upload and queue ZIP validation",
      security: [{ Bearer: [] }],
      middleware: [
        requireContentWrite(),
        paceContentAccount(),
        boundContentRequest()
      ] as const,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: PackageBuildSchema } }
        }
      },
      responses: {
        202: {
          content: {
            "application/json": {
              schema: z.object({ result: PackagingJobSchema })
            }
          },
          description:
            "Private processing job; identical requests reuse queued or completed work"
        },
        ...packageErrors
      }
    }),
    async (c) => {
      try {
        const db = c.env.DB_EXTENSIONS;
        const repository = new PackageBuildDatabase(db);
        const request = c.req.valid("json");
        const dispatcher = packageDispatcher(c.env);
        const scope = await dispatcher.scope();
        const jobs = new PackagingJobsDatabase(db, scope);
        const uploadId = request.upload_id;
        const upload = await repository.getUpload(
          uploadId,
          scope,
          getAuth(c).userId,
          getPublisher(c)
        );
        if (!upload)
          throw new PackageError(
            "UPLOAD_NOT_FOUND",
            "Package upload not found",
            404
          );

        const baseUrl = getPlatform(c).getEnv("EXTENSION_PACKAGES_BASE_URL");
        if (!baseUrl)
          throw new PackageError(
            "PACKAGES_DISABLED",
            "Package download URL is not configured",
            503
          );

        let job = await jobs.find(upload.fingerprint);
        if (!job) {
          if (upload.expires_at <= Math.floor(Date.now() / 1000))
            throw new PackageError(
              "UPLOAD_EXPIRED",
              "Package upload expired; select the ZIP and try again",
              409
            );
          const stored = await packageStore(c)!.head(uploadId);
          if (
            !stored ||
            stored.bytes !== upload.bytes ||
            stored.checksum !== upload.sha256
          )
            throw new PackageError(
              "UPLOAD_INCOMPLETE",
              "The uploaded ZIP is missing or does not match the reservation",
              409
            );
          // Arm recovery before inserting so an interrupted request can be picked up.
          await dispatcher.wake();
          job = await jobs.create({
            fingerprint: upload.fingerprint,
            owner: upload.owner,
            target: upload.target,
            uploadObjectId: uploadId,
            uploadSha256: upload.sha256
          });
        }
        if (job.status === "queued") await dispatcher.wake(true);
        c.header(
          "Location",
          getPlatform(c).getEnv("ENVIRONMENT") === "preview"
            ? new URL(`/extensions/v2/packaging-jobs/${job.id}`, c.req.url).href
            : `${baseUrl.replace(/\/$/, "")}/packaging-jobs/${job.id}`
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
        const dispatcher = packageDispatcher(c.env);
        const job = await new PackagingJobsDatabase(
          db,
          await dispatcher.scope()
        ).get(c.req.valid("param").jobId);
        if (!job)
          throw new PackageError("NOT_FOUND", "Packaging job not found", 404);
        const response = await jobResponse(db, job);
        const userId = getAuth(c).userId;
        const moderator = await repository.isModerator(userId);
        if (!moderator) {
          const publisher = getPublisher(c);
          const owner = await repository.getOwner(
            userId,
            response.result.extension_identifier,
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
        return c.json(response, 200);
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
