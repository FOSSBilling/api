import { PackageJobsDatabase } from "../../../../src/services/extensions/v2/db/package-jobs";
import { processPackageJob } from "../../../../src/services/extensions/v2/packages/jobs";
import {
  recoverPackageJobs,
  prepareQueuedPackage
} from "../../../../src/services/extensions/v2/packages/cloudflare-queue";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
  ZipReader,
  TextWriter
} from "@zip.js/zip.js";
import app from "../../../../src/app";
import {
  signAccessToken,
  activateM2mJwks,
  deactivateM2mJwks
} from "../../../lib/auth/m2m-helper";
import { PackageArtifactSchema } from "../../../../src/services/extensions/v2/schemas/packages";
import { ManifestSchema } from "../../../../src/services/extensions/v2/schemas/manifest";
import { ExtensionContentSchema } from "../../../../src/services/extensions/v2/schemas/extensions";
import {
  validatePackageContent,
  contentManifest
} from "../../../../src/services/extensions/v2/db/packages";
import { sha256 } from "../../../../src/services/extensions/v2/package-builder";
import {
  setupExtensionsV2Tests,
  authHeaders,
  seedDeveloper,
  sampleContent,
  post,
  get,
  put,
  db
} from "./harness";
import { insertUser, getExtension, getDeveloper, UUID_V7 } from "./db-fixtures";

vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);
setupExtensionsV2Tests();
const options = { useWebWorkers: false, useCompressionStream: true };
const root = "/extensions/v2";
const manifest = () =>
  contentManifest(
    "package-demo",
    ExtensionContentSchema.parse(sampleContent())
  );
const bucket = () => env.EXTENSION_PACKAGE_BUCKET!;

beforeEach(async () => {
  vi.spyOn(env.EXTENSION_PACKAGE_QUEUE, "send").mockResolvedValue({
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }
  });
  delete env.EXTENSION_PACKAGES_S3_ENDPOINT;
  delete env.EXTENSION_ASSETS_S3_ENDPOINT;
  env.ENVIRONMENT = "local";
  env.EXTENSION_PACKAGES_MODE = "local";
  env.EXTENSION_PACKAGES_BASE_URL = "http://localhost:8789/extensions/v2";
  await authHeaders("owner");
  await seedDeveloper("developer", "owner");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "PUBLIC_URL"
  ])
    delete (env as unknown as Record<string, unknown>)[
      `EXTENSION_ASSETS_${key}`
    ];
  for (const suffix of [
    "ENDPOINT",
    "REGION",
    "BUCKET",
    "ACCESS_KEY_ID",
    "SECRET_ACCESS_KEY",
    "PREFIX"
  ])
    delete (env as unknown as Record<string, unknown>)[
      `EXTENSION_PACKAGES_S3_${suffix}`
    ];
  env.EXTENSION_PACKAGES_MODE = "disabled";
});
async function zip(content = "<?php // source") {
  const writer = new ZipWriter(new Uint8ArrayWriter(), options);
  await writer.add("Service.php", new TextReader(content));
  return writer.close();
}
async function upload(
  metadata: unknown = manifest(),
  source?: Uint8Array<ArrayBuffer>,
  sourceId?: string,
  user = "owner",
  process = true
) {
  const headers = await authHeaders(user);
  delete headers["Content-Type"];
  const form = new FormData();
  form.set("manifest", JSON.stringify(metadata));
  if (sourceId) form.set("source_id", sourceId);
  else
    form.set(
      "source",
      new File([source ?? (await zip())], "source.zip", {
        type: "application/zip"
      })
    );
  const ctx = createExecutionContext();
  const response = await app.request(
    `${root}/packages`,
    { method: "POST", headers, body: form },
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return process ? finishJob(response) : response;
}
async function finishJob(response: Response): Promise<Response> {
  if (response.status !== 202) return response;
  const { result } = (await response.json()) as { result: { id: string } };
  const jobs = new PackageJobsDatabase(env.DB_EXTENSIONS);
  let job = (await jobs.get(result.id))!;
  for (
    let attempt = 0;
    attempt < 100 && job.status !== "ready" && job.status !== "failed";
    attempt++
  ) {
    await processPackageJob(jobs, result.id, (job) =>
      prepareQueuedPackage(env, job)
    );
    job = (await jobs.get(result.id))!;
    if (job.status === "processing")
      await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (job.status === "ready") {
    const read = await get(
      `${root}/packages/${job.artifactId}`,
      await authHeaders("owner")
    );
    if (read.status !== 200) return read;
    return new Response(await read.text(), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  }
  return Response.json(
    { error: job.error },
    { status: job.error?.status ?? 503 }
  );
}
async function built(
  metadata: unknown = manifest(),
  source?: Uint8Array<ArrayBuffer>,
  sourceId?: string
) {
  const response = await upload(metadata, source, sourceId);
  const body = (await response.json()) as { result: unknown };
  expect(response.status, JSON.stringify(body)).toBe(201);
  return PackageArtifactSchema.parse(body.result);
}
function content(artifact: ReturnType<typeof PackageArtifactSchema.parse>) {
  const { id: _id, ...metadata } = artifact.manifest;
  return {
    ...sampleContent(),
    ...metadata,
    download_url: artifact.download_url,
    releases: [
      {
        tag: artifact.manifest.version,
        date: "2026-11-05",
        requires: artifact.manifest.requires,
        artifact_id: artifact.id,
        sha256: artifact.sha256,
        download_url: artifact.download_url
      }
    ]
  };
}
async function submitted(
  artifact: ReturnType<typeof PackageArtifactSchema.parse>
) {
  const response = await post(
    `${root}/extensions`,
    await authHeaders("owner"),
    { identifier: "package-demo", ...content(artifact) }
  );
  const body = (await response.json()) as { result: { revision_id: string } };
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body.result.revision_id;
}
async function approve(revision: string) {
  await insertUser(db, { id: "moderator", is_moderator: 1 });
  return post(
    `${root}/extensions/package-demo/revisions/${revision}/approve`,
    await authHeaders("moderator"),
    {}
  );
}
async function unpack(bytes: Uint8Array<ArrayBuffer>) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), options);
  const result: Record<string, string> = {};
  try {
    for await (const entry of reader.getEntriesGenerator())
      if (!entry.directory)
        result[entry.filename] = await entry.getData(new TextWriter());
  } finally {
    await reader.close();
  }
  return result;
}

describe("publisher package builds", () => {
  beforeEach(async () => {
    await activateM2mJwks();
    await insertUser(db, { id: "publisher-moderator", is_moderator: 1 });
    const response = await put(
      `${root}/m2m/clients/package-publisher`,
      await authHeaders("publisher-moderator"),
      {
        developer_id: (await getDeveloper(db, "developer"))!.id,
        can_publish: true
      }
    );
    expect(response.status).toBe(200);
  });
  afterEach(() => deactivateM2mJwks());
  async function machineBuild(scopes = ["extensions:push"], process = true) {
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest()));
    form.set("source", new File([await zip()], "source.zip"));
    const response = await app.request(
      `${root}/packages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await signAccessToken({ clientId: "package-publisher", scopes })}`
        },
        body: form
      },
      env
    );
    return process ? finishJob(response) : response;
  }
  it("lets an active machine publisher poll its own queued and ready job", async () => {
    const response = await machineBuild(["extensions:push"], false);
    expect(response.status).toBe(202);
    const { result: job } = (await response.json()) as {
      result: { id: string };
    };
    const headers = {
      Authorization: `Bearer ${await signAccessToken({ clientId: "package-publisher", scopes: ["extensions:push"] })}`
    };
    const pending = await get(`${root}/package-jobs/${job.id}`, headers);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({
      result: { status: "queued", artifact: null }
    });
    expect(
      (await finishJob(Response.json({ result: job }, { status: 202 }))).status
    ).toBe(201);
    const ready = await get(`${root}/package-jobs/${job.id}`, headers);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      result: {
        status: "ready",
        artifact: { manifest: { id: "package-demo" } }
      }
    });
    await db
      .prepare(
        "UPDATE m2m_publisher_clients SET revoked_at=CURRENT_TIMESTAMP WHERE client_id='package-publisher'"
      )
      .run();
    expect((await get(`${root}/package-jobs/${job.id}`, headers)).status).toBe(
      403
    );
  });
  it("builds under the mapped developer while retaining owner privacy", async () => {
    const response = await machineBuild();
    expect(response.status).toBe(201);
    const artifact = PackageArtifactSchema.parse(
      ((await response.json()) as { result: unknown }).result
    );
    const source = await db
      .prepare("SELECT profile_generation FROM package_sources WHERE id=?")
      .bind(artifact.source_id)
      .first();
    expect(source).toBeTruthy();
    expect(
      (await get(`${root}/packages/${artifact.id}/download`, {})).status
    ).toBe(404);
    expect(
      (
        await get(
          `${root}/packages/${artifact.id}/download`,
          await authHeaders("owner")
        )
      ).status
    ).toBe(200);
    const token = await signAccessToken({
      clientId: "package-publisher",
      scopes: ["extensions:push", "extensions:publish"]
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    };
    const created = await post(`${root}/extensions`, headers, {
      identifier: "package-demo",
      ...content(artifact)
    });
    expect(created.status).toBe(201);
    const revision = (
      (await created.json()) as { result: { revision_id: string } }
    ).result.revision_id;
    expect(
      (
        await post(
          `${root}/extensions/package-demo/revisions/${revision}/approve`,
          headers,
          {}
        )
      ).status
    ).toBe(200);
    expect(
      (await get(`${root}/packages/${artifact.id}/download`, {})).status
    ).toBe(200);
  });
  it("requires push scope and refuses revoked or stale bindings", async () => {
    expect((await machineBuild(["extensions:publish"])).status).toBe(403);
    await db
      .prepare(
        "UPDATE m2m_publisher_clients SET revoked_at=CURRENT_TIMESTAMP WHERE client_id='package-publisher'"
      )
      .run();
    expect((await machineBuild()).status).toBe(403);
    await db
      .prepare(
        "UPDATE m2m_publisher_clients SET revoked_at=NULL,ownership_epoch=ownership_epoch+1 WHERE client_id='package-publisher'"
      )
      .run();
    expect((await machineBuild()).status).toBe(403);
  });
  it("does not reserve a package belonging to a different developer", async () => {
    await seedDeveloper("another-developer", "another-owner");
    await db
      .prepare(
        "UPDATE m2m_publisher_clients SET developer_id=(SELECT id FROM developers WHERE identifier='another-developer') WHERE client_id='package-publisher'"
      )
      .run();
    // New IDs can be reserved by that developer, but an existing owned ID cannot.
    const artifact = await built();
    await submitted(artifact);
    expect((await machineBuild()).status).toBe(403);
  });
  it("rechecks revocation after uploading before linking source bytes", async () => {
    const original = bucket().put.bind(bucket());
    const write = vi
      .spyOn(bucket(), "put")
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        await db
          .prepare(
            "UPDATE m2m_publisher_clients SET revoked_at=CURRENT_TIMESTAMP WHERE client_id='package-publisher'"
          )
          .run();
        return result;
      });
    try {
      expect((await machineBuild()).status).toBe(403);
      expect(
        await db
          .prepare("SELECT count(*) as count FROM package_sources")
          .first()
      ).toEqual({ count: 0 });
    } finally {
      write.mockRestore();
    }
  });
});

describe("queued package preparation", () => {
  it("accepts a private job without preparing an artifact and deduplicates retries", async () => {
    const source = await zip();
    const response = await upload(
      manifest(),
      source,
      undefined,
      "owner",
      false
    );
    expect(response.status).toBe(202);
    const { result: job } = (await response.json()) as {
      result: { id: string; status: string };
    };
    expect(job.status).toBe("queued");
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM package_artifacts")
        .first()
    ).toEqual({ count: 0 });
    expect(env.EXTENSION_PACKAGE_QUEUE.send).toHaveBeenCalledWith(
      { jobId: job.id },
      { contentType: "json" }
    );
    const repeat = await upload(manifest(), source, undefined, "owner", false);
    expect(
      ((await repeat.json()) as { result: { id: string } }).result.id
    ).toBe(job.id);
    expect((await get(`${root}/package-jobs/${job.id}`, {})).status).toBe(401);
    expect(
      (
        await get(
          `${root}/package-jobs/${job.id}`,
          await authHeaders("stranger")
        )
      ).status
    ).toBe(403);
    const finished = await finishJob(
      Response.json({ result: job }, { status: 202 })
    );
    expect(finished.status).toBe(201);
    const status = await get(
      `${root}/package-jobs/${job.id}`,
      await authHeaders("owner")
    );
    expect(
      ((await status.json()) as { result: { status: string } }).result.status
    ).toBe("ready");
  });
  it("does not process a job after its developer ownership changes", async () => {
    const response = await upload(
      manifest(),
      undefined,
      undefined,
      "owner",
      false
    );
    const { result: job } = (await response.json()) as {
      result: { id: string };
    };
    await db
      .prepare(
        "UPDATE developers SET ownership_epoch=ownership_epoch+1 WHERE identifier = 'developer'"
      )
      .run();
    expect(
      (await finishJob(Response.json({ result: job }, { status: 202 }))).status
    ).toBe(403);
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM package_artifacts")
        .first()
    ).toEqual({ count: 0 });
  });
  it("keeps the job recoverable if queue publication fails", async () => {
    vi.mocked(env.EXTENSION_PACKAGE_QUEUE.send).mockRejectedValueOnce(
      new Error("queue unavailable")
    );
    expect(
      (await upload(manifest(), undefined, undefined, "owner", false)).status
    ).toBe(503);
    const jobs = new PackageJobsDatabase(db);
    const ids = await jobs.pending();
    expect(ids).toHaveLength(1);
    const { dispatchPackageJob } =
      await import("../../../../src/services/extensions/v2/packages/jobs");
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchPackageJob(jobs, { send }, ids[0]);
    expect(send).toHaveBeenCalledWith({ jobId: ids[0] });
    expect(await jobs.pending()).toEqual([]);
  });
  it("continues recovery after one queue dispatch fails", async () => {
    await upload(manifest(), undefined, undefined, "owner", false);
    await upload(
      { ...manifest(), version: "2.0.0" },
      undefined,
      undefined,
      "owner",
      false
    );
    await db.prepare("UPDATE package_jobs SET enqueued_at=NULL").run();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(env.EXTENSION_PACKAGE_QUEUE.send)
      .mockClear()
      .mockRejectedValueOnce(new Error("queue unavailable"));
    await recoverPackageJobs(env);
    expect(env.EXTENSION_PACKAGE_QUEUE.send).toHaveBeenCalledTimes(2);
    expect(await new PackageJobsDatabase(db).pending()).toHaveLength(1);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ error: "queue unavailable" })
      })
    );
  });
  it("retries a missing staged upload and completes when storage recovers", async () => {
    const source = await zip();
    const response = await upload(
      manifest(),
      source,
      undefined,
      "owner",
      false
    );
    const { result } = (await response.json()) as { result: { id: string } };
    const jobs = new PackageJobsDatabase(db);
    const job = (await jobs.get(result.id))!;
    await bucket().delete(job.uploadObjectId!);
    expect(
      await processPackageJob(jobs, job.id, (job) =>
        prepareQueuedPackage(env, job)
      )
    ).toBe("retry");
    expect(await jobs.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      error: { code: "SOURCE_UNAVAILABLE", status: 503 }
    });
    await bucket().put(job.uploadObjectId!, source, {
      sha256: job.uploadSha256!
    });
    expect(
      await processPackageJob(jobs, job.id, (job) =>
        prepareQueuedPackage(env, job)
      )
    ).toBe("ack");
    expect(await jobs.get(job.id)).toMatchObject({
      status: "ready",
      attempts: 2,
      error: null
    });
  });
  it("recovers an expired processing lease without accepting stale completion", async () => {
    const response = await upload(
      manifest(),
      undefined,
      undefined,
      "owner",
      false
    );
    const { result: job } = (await response.json()) as {
      result: { id: string };
    };
    const jobs = new PackageJobsDatabase(db);
    expect(await jobs.claim(job.id, "first")).not.toBeNull();
    expect(await jobs.claim(job.id, "second")).toBeNull();
    await db
      .prepare(
        "UPDATE package_jobs SET lease_until=datetime('now','-1 minute') WHERE id=?"
      )
      .bind(job.id)
      .run();
    const claimed = await jobs.claim(job.id, "second");
    expect(claimed?.attempts).toBe(2);
    await jobs.fail(
      job.id,
      "first",
      { code: "STALE", message: "Old worker", status: 503 },
      false
    );
    expect((await jobs.get(job.id))!.status).toBe("processing");
    const artifactId = await prepareQueuedPackage(env, claimed!);
    await jobs.complete(job.id, "second", artifactId);
    expect((await jobs.get(job.id))!.status).toBe("ready");
  });
  it("claims a job once across concurrent deliveries", async () => {
    const response = await upload(
      manifest(),
      undefined,
      undefined,
      "owner",
      false
    );
    const { result: job } = (await response.json()) as {
      result: { id: string };
    };
    const jobs = new PackageJobsDatabase(db);
    const prepare = vi.fn(
      (
        job: import("../../../../src/services/extensions/v2/packages/jobs").PackageJob
      ) => prepareQueuedPackage(env, job)
    );
    await Promise.all([
      processPackageJob(jobs, job.id, prepare),
      processPackageJob(jobs, job.id, prepare)
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await jobs.get(job.id))!.status).toBe("ready");
  });
});

describe("stored directory packages", () => {
  it("uses separate B2 buckets for ZIPs and icons through preparation, correction and approval", async () => {
    const remote = configureB2({
      EXTENSION_PACKAGES_S3_ENDPOINT: "https://s3.example.test",
      EXTENSION_PACKAGES_S3_REGION: "eu-central-003",
      EXTENSION_PACKAGES_S3_BUCKET: "test-packages",
      EXTENSION_PACKAGES_S3_ACCESS_KEY_ID: "test-key",
      EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY: "test-secret"
    });
    const requests = remote.calls;
    const writer = new ZipWriter(new Uint8ArrayWriter(), options);
    await writer.add("Service.php", new TextReader("<?php // B2 test"));
    await writer.add(
      "icon.svg",
      new TextReader(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
      )
    );
    const first = await built(manifest(), await writer.close());
    const revised = await built(
      { ...manifest(), description: "Rebuilt from B2 source" },
      undefined,
      first.source_id
    );
    expect(revised.source_id).toBe(first.source_id);
    const uploads = requests.filter((request) => request.method === "PUT");
    expect(uploads).toHaveLength(4); // source, two manifests and one shared icon
    expect(
      uploads.filter((request) =>
        new URL(request.url).pathname.startsWith(
          "/test-packages/local/packages/"
        )
      )
    ).toHaveLength(3);
    expect(
      uploads.filter((request) =>
        new URL(request.url).pathname.startsWith("/test-assets/extensions/")
      )
    ).toHaveLength(1);
    const path = `${root}/packages/${revised.id}/download`;
    const before = requests.length;
    expect((await get(path, {})).status).toBe(404);
    expect(requests.length).toBe(before);
    const owner = await get(path, await authHeaders("owner"));
    expect(owner.status).toBe(200);
    expect(await sha256(new Uint8Array(await owner.arrayBuffer()))).toBe(
      revised.sha256
    );
    expect((await get(`${root}/packages/${revised.id}/icon`, {})).status).toBe(
      404
    );
    expect(
      (
        await get(
          `${root}/packages/${revised.id}/icon`,
          await authHeaders("owner")
        )
      ).status
    ).toBe(200);
    const revision = await submitted(revised);
    expect((await approve(revision)).status).toBe(200);
    const publicDownload = await get(path, {});
    expect(publicDownload.status).toBe(200);
    expect(publicDownload.headers.get("Cache-Control")).toBe(
      "private, no-store"
    );
    expect(
      await sha256(new Uint8Array(await publicDownload.arrayBuffer()))
    ).toBe(revised.sha256);
  });

  it("keeps uploads private until approval and publishes the exact reviewed ZIP", async () => {
    const artifact = await built();
    const path = `${root}/packages/${artifact.id}/download`;
    expect((await get(path, {})).status).toBe(404);
    expect((await get(path, await authHeaders("stranger"))).status).toBe(404);
    expect((await get(path, await authHeaders("owner"))).status).toBe(200);
    const revision = await submitted(artifact);
    expect((await get(path, {})).status).toBe(404);
    expect((await approve(revision)).status).toBe(200);
    const download = await get(path, {});
    expect(download.status).toBe(200);
    expect(download.headers.get("Cache-Control")).toContain("no-store");
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(await sha256(bytes)).toBe(artifact.sha256);
    const files = await unpack(bytes);
    expect(files["Service.php"]).toBe("<?php // source");
    expect(ManifestSchema.parse(JSON.parse(files["manifest.json"]))).toEqual(
      artifact.manifest
    );
    const published = await getExtension(db, "package-demo");
    expect(JSON.parse(published!.releases!)[0]).toMatchObject({
      artifact_id: artifact.id,
      sha256: artifact.sha256
    });
    await db
      .prepare(
        "UPDATE extensions SET delisted_at=CURRENT_TIMESTAMP WHERE identifier='package-demo'"
      )
      .run();
    expect((await get(path, {})).status).toBe(404);
  });

  it("serves convention icons with the same publication permissions as downloads", async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), options);
    await writer.add("Service.php", new TextReader("<?php"));
    await writer.add(
      "icon.svg",
      new TextReader(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 256"><rect width="512" height="256" fill="blue"/></svg>'
      )
    );
    const artifact = await built(manifest(), await writer.close());
    const path = `${root}/packages/${artifact.id}/icon`;
    expect((await get(path, {})).status).toBe(404);
    expect((await get(path, await authHeaders("stranger"))).status).toBe(404);
    const preview = await get(path, await authHeaders("owner"));
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(preview.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await preview.text()).toContain("<rect");
    const avif = await get(path, {
      ...(await authHeaders("owner")),
      Accept: "image/avif,image/webp,*/*"
    });
    expect(avif.headers.get("Content-Type")).toBe("image/svg+xml");
    const before = await db
      .prepare(
        "SELECT svg_object_id,avif_object_id,png_object_id FROM package_icons WHERE source_id=?"
      )
      .bind(artifact.source_id)
      .first();
    await built(
      { ...manifest(), description: "Updated metadata" },
      undefined,
      artifact.source_id
    );
    expect(
      await db
        .prepare(
          "SELECT svg_object_id,avif_object_id,png_object_id FROM package_icons WHERE source_id=?"
        )
        .bind(artifact.source_id)
        .first()
    ).toEqual(before);
    const object = await db
      .prepare("SELECT object_id FROM package_artifacts WHERE id=?")
      .bind(artifact.id)
      .first<{ object_id: string }>();
    await bucket().delete(object!.object_id);
    // Reading the icon must not depend on opening the ZIP.
    expect((await get(path, await authHeaders("owner"))).status).toBe(200);
    expect((await approve(await submitted(artifact))).status).toBe(200);
    expect((await get(path, {})).status).toBe(200);
    const published = await getExtension(db, "package-demo");
    expect(published?.icon_url).toBe(
      artifact.download_url.replace(/\/download$/, "/icon")
    );
    await db
      .prepare(
        "UPDATE extensions SET delisted_at=CURRENT_TIMESTAMP WHERE identifier='package-demo'"
      )
      .run();
    expect((await get(path, {})).status).toBe(404);
  });
  it("sanitizes SVG scripts, events, foreign content, and stylesheets while preserving vector artwork", async () => {
    const original = `<?xml version="1.0"?><?xml-stylesheet href="https://untrusted.example/style.xsl" type="text/xsl"?>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert(1)">
        <script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">HTML</div></foreignObject>
        <defs><linearGradient id="paint"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>
        <path d="M0 0h24v24H0z" fill="url(#paint)"/>
        <image href="https://untrusted.example/tracker.png"/>
      </svg>`;
    const writer = new ZipWriter(new Uint8ArrayWriter(), options);
    await writer.add("icon.svg", new TextReader(original));
    const artifact = await built(manifest(), await writer.close());
    const response = await get(
      `${root}/packages/${artifact.id}/icon`,
      await authHeaders("owner")
    );
    const svg = await response.text();
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(svg).not.toMatch(
      /script|onload|foreignObject|untrusted\.example|xml-stylesheet/
    );
    expect(svg).toContain("linearGradient");
    expect(svg).toContain("url(#paint)");
    expect(svg).toContain('viewBox="0 0 24 24"');
    const row = await db
      .prepare(
        "SELECT svg_object_id,avif_object_id,png_object_id FROM package_icons WHERE source_id=?"
      )
      .bind(artifact.source_id)
      .first<{
        svg_object_id: string;
        avif_object_id: null;
        png_object_id: null;
      }>();
    expect(row?.svg_object_id).toMatch(
      /^extensions\/[a-f0-9-]{36}\/icons\/[a-f0-9-]{36}\.svg$/
    );
    expect(row?.avif_object_id).toBeNull();
    expect(row?.png_object_id).toBeNull();
    const download = await get(
      `${root}/packages/${artifact.id}/download`,
      await authHeaders("owner")
    );
    const zip = new ZipReader(
      new Uint8ArrayReader(new Uint8Array(await download.arrayBuffer())),
      options
    );
    try {
      const icon = (await zip.getEntries()).find(
        (entry) => entry.filename === "icon.svg"
      )!;
      if (icon.directory) throw new Error("Expected icon file");
      expect(await icon.getData(new TextWriter())).toBe(original);
    } finally {
      await zip.close();
    }
  });
  it.each([
    "<svg",
    '<html xmlns="http://www.w3.org/1999/xhtml"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><!--' +
      "x".repeat(2 * 1024 * 1024) +
      "--></svg>"
  ])("rejects malformed, non-SVG, and oversized SVG files %#", async (svg) => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), options);
    await writer.add("icon.svg", new TextReader(svg));
    expect((await upload(manifest(), await writer.close())).status).toBe(422);
    expect(
      await db.prepare("SELECT count(*) AS count FROM package_sources").first()
    ).toEqual({ count: 0 });
  });
  it("sanitizes SVG content even with a raster filename", async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), options);
    await writer.add(
      "icon.png",
      new TextReader(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" onload="alert(1)"><path d="M0 0h24v24z"/></svg>'
      )
    );
    const artifact = await built(manifest(), await writer.close());
    const response = await get(
      `${root}/packages/${artifact.id}/icon`,
      await authHeaders("owner")
    );
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await response.text()).not.toContain("onload");
  });
  it.each(["png", "webp", "avif"] as const)(
    "converts icon.%s to bounded AVIF and PNG images",
    async (format) => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="256"><rect width="512" height="256" fill="blue"/></svg>';
      const image = await env
        .PACKAGE_IMAGES!.input(new Blob([svg]).stream())
        .output({ format: `image/${format}` });
      const original = new Uint8Array(await image.response().arrayBuffer());
      const writer = new ZipWriter(new Uint8ArrayWriter(), options);
      await writer.add(`icon.${format}`, new Uint8ArrayReader(original));
      const artifact = await built(manifest(), await writer.close());
      const response = await get(
        `${root}/packages/${artifact.id}/icon`,
        await authHeaders("owner")
      );
      const avif = await get(`${root}/packages/${artifact.id}/icon`, {
        ...(await authHeaders("owner")),
        Accept: "image/avif,image/png"
      });
      expect(avif.headers.get("Content-Type")).toBe("image/avif");
      expect(
        new TextDecoder().decode((await avif.arrayBuffer()).slice(4, 12))
      ).toBe("ftypavif");
      expect(
        (
          await get(`${root}/packages/${artifact.id}/icon`, {
            ...(await authHeaders("owner")),
            Accept: "image/avif;q=0,image/png"
          })
        ).headers.get("Content-Type")
      ).toBe("image/png");
      const info = await env.PACKAGE_IMAGES!.info(response.body!);
      expect(info).toMatchObject({
        format: "image/png",
        width: 256,
        height: 128
      });
      const download = await get(
        `${root}/packages/${artifact.id}/download`,
        await authHeaders("owner")
      );
      const zip = new ZipReader(
        new Uint8ArrayReader(new Uint8Array(await download.arrayBuffer())),
        options
      );
      try {
        const entry = (await zip.getEntries()).find(
          (entry) => entry.filename === `icon.${format}`
        )!;
        if (entry.directory) throw new Error("Expected icon file");
        expect(await entry.getData(new Uint8ArrayWriter())).toEqual(original);
      } finally {
        await zip.close();
      }
    }
  );

  it("lets moderators rebuild published source for a correction without uploading new files", async () => {
    const artifact = await built();
    const revision = await submitted(artifact);
    expect((await approve(revision)).status).toBe(200);
    const corrected = { ...manifest(), description: "Moderator correction" };
    const response = await upload(
      corrected,
      undefined,
      artifact.source_id,
      "moderator"
    );
    expect(response.status).toBe(201);
    const next = PackageArtifactSchema.parse(
      ((await response.json()) as { result: unknown }).result
    );
    expect(next.source_id).toBe(artifact.source_id);
    expect(next.manifest.description).toBe(corrected.description);
    expect(
      (await upload(corrected, await zip(), undefined, "moderator")).status
    ).toBe(403);
    expect(
      (
        await post(
          `${root}/extensions/package-demo/moderator-correct`,
          await authHeaders("moderator"),
          {
            ...content(next),
            correction_note: "Correct the package metadata"
          }
        )
      ).status
    ).toBe(200);
  });

  it("rejects invalid icons without reserving the source version", async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), options);
    await writer.add("icon.png", new TextReader("not an image"));
    const response = await upload(manifest(), await writer.close());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_ICON" }
    });
    expect(
      await db.prepare("SELECT count(*) AS count FROM package_sources").first()
    ).toEqual({ count: 0 });
    expect((await upload()).status).toBe(201);
  });

  function configureB2(overrides: Record<string, string> = {}) {
    Object.assign(env, {
      EXTENSION_ASSETS_S3_ENDPOINT: "https://s3.example.test",
      EXTENSION_ASSETS_S3_REGION: "eu-central-003",
      EXTENSION_ASSETS_S3_BUCKET: "test-assets",
      EXTENSION_ASSETS_S3_ACCESS_KEY_ID: "test-key",
      EXTENSION_ASSETS_S3_SECRET_ACCESS_KEY: "test-secret",
      EXTENSION_ASSETS_PUBLIC_URL: "https://extensions-assets.fossbilling.net",
      ...overrides
    });
    const calls: Request[] = [];
    const objects = new Map<string, { bytes: ArrayBuffer; checksum: string }>();
    let failure = false;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        expect(new URL(request.url).hostname).toBe("s3.example.test");
        calls.push(request.clone());
        if (failure) return new Response(null, { status: 503 });
        const key = new URL(request.url).pathname;
        if (request.method === "PUT") {
          objects.set(key, {
            bytes: await request.arrayBuffer(),
            checksum: request.headers.get("x-amz-meta-sha256")!
          });
          return new Response(null);
        }
        const object = objects.get(key);
        if (!object) return new Response(null, { status: 404 });
        expect(request.method).toBe("GET");
        return new Response(object.bytes, {
          headers: { "x-amz-meta-sha256": object.checksum }
        });
      }
    );
    return {
      calls,
      fail: (value: boolean) => {
        failure = value;
      }
    };
  }
  async function iconSource(format: "svg" | "png" = "svg") {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h24v24z"/></svg>';
    const bytes =
      format === "svg"
        ? new TextEncoder().encode(svg)
        : new Uint8Array(
            await (
              await env
                .PACKAGE_IMAGES!.input(new Blob([svg]).stream())
                .output({ format: "image/png" })
            )
              .response()
              .arrayBuffer()
          );
    const writer = new ZipWriter(new Uint8ArrayWriter(), options);
    await writer.add(
      `icon.${format}`,
      new Uint8ArrayReader(new Uint8Array(bytes))
    );
    return writer.close();
  }
  it("stores pending icons at unlisted B2 URLs using the permanent draft UUID", async () => {
    const remote = configureB2();
    const artifact = await built(manifest(), await iconSource());
    const draft = (await getExtension(db, "package-demo"))!;
    expect(draft.id).toMatch(UUID_V7);
    expect(draft.published_at).toBeNull();
    expect(
      (await get(`${root}/extensions/package-demo`, await authHeaders("owner")))
        .status
    ).toBe(200);
    expect((await get(`${root}/extensions/package-demo`, {})).status).toBe(404);
    const uploads = remote.calls.filter((r) => r.method === "PUT");
    expect(uploads).toHaveLength(1);
    const upload = uploads[0];
    const objectKey = new URL(upload.url).pathname.replace("/test-assets/", "");
    expect(objectKey).toMatch(
      new RegExp(`^extensions/${draft.id}/icons/[a-f0-9-]{36}\\.svg$`)
    );
    const callsBefore = remote.calls.length;
    expect((await get(`${root}/packages/${artifact.id}/icon`, {})).status).toBe(
      404
    );
    expect(
      (
        await get(
          `${root}/packages/${artifact.id}/icon`,
          await authHeaders("stranger")
        )
      ).status
    ).toBe(404);
    expect(remote.calls).toHaveLength(callsBefore);
    const preview = await get(
      `${root}/packages/${artifact.id}/icon`,
      await authHeaders("owner")
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await preview.text()).toContain("<svg");
    expect(remote.calls.at(-1)?.url).toBe(upload.url);
    const pending = await submitted(artifact);
    const callsBeforeApproval = remote.calls.length;
    expect((await approve(pending)).status).toBe(200);
    const published = (await getExtension(db, "package-demo"))!;
    expect(published.id).toBe(draft.id);
    expect(published.icon_url).toBe(
      `https://extensions-assets.fossbilling.net/${objectKey}`
    );
    expect(remote.calls).toHaveLength(callsBeforeApproval);
    const edited = await built(
      { ...manifest(), description: "Updated metadata" },
      undefined,
      artifact.source_id
    );
    const update = await put(
      `${root}/extensions/package-demo`,
      await authHeaders("owner"),
      content(edited)
    );
    expect(update.status).toBe(202);
    const { result } = (await update.json()) as {
      result: { revision_id: string };
    };
    expect((await approve(result.revision_id)).status).toBe(200);
    expect((await getExtension(db, "package-demo"))?.icon_url).toBe(
      published.icon_url
    );
    expect(remote.calls.filter((r) => r.method === "PUT")).toHaveLength(1);
  });
  it("fails preparation on asset upload errors and retries without changing storage backends", async () => {
    const remote = configureB2();
    const source = await iconSource();
    remote.fail(true);
    expect((await upload(manifest(), source)).status).toBe(503);
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM package_artifacts")
        .first()
    ).toEqual({ count: 0 });
    remote.fail(false);
    const artifact = await built(manifest(), source);
    expect(
      (
        await get(
          `${root}/packages/${artifact.id}/icon`,
          await authHeaders("owner")
        )
      ).status
    ).toBe(200);
    expect((await approve(await submitted(artifact))).status).toBe(200);
    expect((await getExtension(db, "package-demo"))?.icon_url).toContain(
      "https://extensions-assets.fossbilling.net/extensions/"
    );
  });
  it("publishes an icon when a valid extension ID is supplied in uppercase", async () => {
    configureB2();
    const artifact = await built(manifest(), await iconSource());
    const revision = await submitted(artifact);
    await insertUser(db, { id: "moderator", is_moderator: 1 });
    expect(
      (
        await post(
          `${root}/extensions/PACKAGE-DEMO/revisions/${revision}/approve`,
          await authHeaders("moderator"),
          {}
        )
      ).status
    ).toBe(200);
    expect((await getExtension(db, "package-demo"))?.icon_url).toMatch(
      /^https:\/\/extensions-assets\.fossbilling\.net\//
    );
  });
  it("publishes AVIF and PNG with one immutable image identity for browser fallback", async () => {
    const remote = configureB2();
    const artifact = await built(manifest(), await iconSource("png"));
    expect((await approve(await submitted(artifact))).status).toBe(200);
    const uploads = remote.calls.filter((request) => request.method === "PUT");
    expect(uploads).toHaveLength(2);
    const extension = (await getExtension(db, "package-demo"))!;
    expect(new URL(uploads[0].url).pathname).toMatch(
      new RegExp(
        `^/test-assets/extensions/${extension.id}/icons/[a-f0-9-]{36}\\.avif$`
      )
    );
    expect(uploads[0].url.replace(/\.avif$/, ".png")).toBe(uploads[1].url);
    expect(
      uploads.map((request) => request.headers.get("Content-Type"))
    ).toEqual(["image/avif", "image/png"]);
    expect((await getExtension(db, "package-demo"))?.icon_url).toBe(
      uploads[1].url.replace(
        "https://s3.example.test/test-assets",
        "https://extensions-assets.fossbilling.net"
      )
    );
  });

  it("serves a generic icon for an authorized package without an icon", async () => {
    const artifact = await built();
    const response = await get(
      `${root}/packages/${artifact.id}/icon`,
      await authHeaders("owner")
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<svg");
  });

  it("deduplicates retries and builds metadata revisions using the stored source", async () => {
    const source = await zip();
    const first = await built(manifest(), source);
    const retry = await built(manifest(), source);
    expect(retry.id).toBe(first.id);
    const second = await built(
      { ...manifest(), description: "Corrected metadata" },
      undefined,
      first.source_id
    );
    expect(second.source_id).toBe(first.source_id);
    expect(second.manifest.version).toBe(first.manifest.version);
    expect(second.id).not.toBe(first.id);
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.download_url).not.toBe(first.download_url);
    const rows = await db
      .prepare("SELECT count(*) AS count FROM package_objects")
      .first<{ count: number }>();
    expect(rows!.count).toBe(3);
  });

  it("reuses a ready artifact without reopening its stored source", async () => {
    const artifact = await built();
    const source = await db
      .prepare("SELECT object_id FROM package_sources WHERE id=?")
      .bind(artifact.source_id)
      .first<{ object_id: string }>();
    await bucket().delete(source!.object_id);
    expect((await built(manifest(), undefined, artifact.source_id)).id).toBe(
      artifact.id
    );
    expect(
      (
        await upload(
          { ...manifest(), description: "Needs a rebuild" },
          undefined,
          artifact.source_id
        )
      ).status
    ).toBe(503);
  });

  it("requires a new version for changed source and hides foreign stored sources", async () => {
    const first = await built();
    expect((await upload(manifest(), await zip("changed source"))).status).toBe(
      409
    );
    const changed = { ...manifest(), version: "1.1.0" };
    expect((await upload(changed, await zip("changed source"))).status).toBe(
      201
    );
    await seedDeveloper("other-developer", "other");
    expect(
      (await upload(manifest(), undefined, first.source_id, "other")).status
    ).toBe(403); // The package has already reserved the extension for its owner.
    expect(
      (
        await upload(
          { ...manifest(), id: "other-extension" },
          undefined,
          first.source_id,
          "other"
        )
      ).status
    ).toBe(404);
  });

  it("rejects metadata/requirements/URL/checksum mismatches at submission", async () => {
    const artifact = await built();
    for (const patch of [
      { description: "Not in ZIP" },
      { download_url: "https://evil.test/not-the-package.zip" },
      { requires: { fossbilling: ">=9.0.0" } },
      {
        releases: [{ ...content(artifact).releases[0], sha256: "0".repeat(64) }]
      },
      {
        releases: [
          {
            ...content(artifact).releases[0],
            requires: { fossbilling: ">=9.0.0" }
          }
        ]
      }
    ]) {
      const response = await post(
        `${root}/extensions`,
        await authHeaders("owner"),
        { identifier: "package-demo", ...content(artifact), ...patch }
      );
      expect(response.status).toBe(409);
    }
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM extensions WHERE identifier='package-demo'"
        )
        .first()
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM extension_revisions")
        .first()
    ).toEqual({ count: 0 });
  });

  it("replaces a pending package, invalidates the old review, and preserves previously published bytes", async () => {
    const first = await built();
    const revision = await submitted(first);
    expect((await approve(revision)).status).toBe(200);
    const second = await built(
      { ...manifest(), description: "Correction" },
      undefined,
      first.source_id
    );
    const proposed = await put(
      `${root}/extensions/package-demo`,
      await authHeaders("owner"),
      content(second)
    );
    expect(proposed.status).toBe(202);
    const oldPending = (
      (await proposed.json()) as { result: { revision_id: string } }
    ).result.revision_id;
    const third = await built(
      { ...manifest(), description: "Final correction" },
      undefined,
      first.source_id
    );
    const replaced = await put(
      `${root}/extensions/package-demo/revisions/${oldPending}`,
      await authHeaders("owner"),
      content(third)
    );
    expect(replaced.status).toBe(202);
    expect((await approve(oldPending)).status).toBe(404);
    expect(
      (await get(`${root}/packages/${second.id}/download`, {})).status
    ).toBe(404);
    expect(
      (
        await approve(
          ((await replaced.json()) as { result: { revision_id: string } })
            .result.revision_id
        )
      ).status
    ).toBe(200);
    expect(
      (await get(`${root}/packages/${first.id}/download`, {})).status
    ).toBe(200);
    expect(
      (await get(`${root}/packages/${third.id}/download`, {})).status
    ).toBe(200);
  });

  it("prevents reverting a managed listing to external downloads or mutating artifacts", async () => {
    const artifact = await built();
    expect((await approve(await submitted(artifact))).status).toBe(200);
    expect(
      (
        await put(
          `${root}/extensions/package-demo`,
          await authHeaders("owner"),
          sampleContent()
        )
      ).status
    ).toBe(409);
    await expect(
      db
        .prepare("UPDATE package_artifacts SET sha256=? WHERE id=?")
        .bind("0".repeat(64), artifact.id)
        .run()
    ).rejects.toThrow("immutable");
    await expect(
      db
        .prepare("UPDATE package_sources SET sha256=? WHERE id=?")
        .bind("0".repeat(64), artifact.source_id)
        .run()
    ).rejects.toThrow("immutable");
  });

  it("retains immutable package rows after job history is pruned", async () => {
    const artifact = await built();
    expect((await approve(await submitted(artifact))).status).toBe(200);
    await db.prepare("DELETE FROM package_jobs").run();
    for (const [table, column, id] of [
      ["package_artifacts", "id", artifact.id],
      ["package_sources", "id", artifact.source_id],
      ["package_icons", "source_id", artifact.source_id]
    ])
      await expect(
        db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).bind(id).run()
      ).rejects.toThrow("immutable");
    expect(
      (
        await post(
          `${root}/packages/cleanup`,
          await authHeaders("moderator"),
          {}
        )
      ).status
    ).toBe(200);
    expect(
      (await get(`${root}/packages/${artifact.id}/download`, {})).status
    ).toBe(200);
  });
  it("fetches artifact references together for a 100-release submission and rejects unknown artifacts", async () => {
    const artifact = await built();
    const first = { ...content(artifact).releases[0], is_latest: true };
    const releases = [
      first,
      ...Array.from({ length: 99 }, (_, i) => ({
        ...first,
        is_latest: false,
        tag: `${i + 2}.0.0`,
        artifact_id: crypto.randomUUID()
      }))
    ];
    const prepared = vi.spyOn(db, "prepare");
    const error = await validatePackageContent(
      db,
      "package-demo",
      "developer",
      ExtensionContentSchema.parse({ ...content(artifact), releases })
    );
    expect(error?.message).toBe("Release does not match its package artifact");
    const artifactQueries = prepared.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes("FROM package_artifacts"));
    expect(artifactQueries).toHaveLength(2); // publication state + the complete artifact set
    expect(artifactQueries[1]).toContain("json_each(?)");
  });
  it("revalidates the artifact at approval rather than trusting submission-time checks", async () => {
    const artifact = await built();
    const revision = await submitted(artifact);
    await db
      .prepare(
        "UPDATE extension_revisions SET content=json_set(content,'$.description','Changed after submission') WHERE id=?"
      )
      .bind(revision)
      .run();
    expect((await approve(revision)).status).toBe(409);
    expect(
      (await get(`${root}/packages/${artifact.id}/download`, {})).status
    ).toBe(404);
  });

  it("detects corrupted stored source and package objects", async () => {
    const artifact = await built();
    const source = await db
      .prepare("SELECT object_id FROM package_sources WHERE id=?")
      .bind(artifact.source_id)
      .first<{ object_id: string }>();
    await bucket().put(source!.object_id, "corrupt");
    expect(
      (
        await upload(
          { ...manifest(), description: "Correction" },
          undefined,
          artifact.source_id
        )
      ).status
    ).toBe(503);
    const stored = await db
      .prepare("SELECT object_id FROM package_artifacts WHERE id=?")
      .bind(artifact.id)
      .first<{ object_id: string }>();
    await bucket().put(stored!.object_id, "corrupt");
    expect(
      (
        await get(
          `${root}/packages/${artifact.id}/download`,
          await authHeaders("owner")
        )
      ).status
    ).toBe(503);
  });

  it("concurrent identical uploads converge on one source and artifact", async () => {
    const source = await zip();
    const [first, second] = await Promise.all([
      built(manifest(), source),
      built(manifest(), source)
    ]);
    expect(first.id).toBe(second.id);
    expect(
      await db.prepare("SELECT count(*) AS count FROM package_sources").first()
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM package_artifacts")
        .first()
    ).toEqual({ count: 1 });
    expect(
      await db.prepare("SELECT count(*) AS count FROM package_objects").first()
    ).toEqual({ count: 3 }); // one duplicate staged upload remains eligible for cleanup
  });

  it("does not allow a removed managed release to return as an external download", async () => {
    const first = await built();
    expect((await approve(await submitted(first))).status).toBe(200);
    const second = await built({ ...manifest(), version: "1.1.0" });
    const nextContent = content(second);
    const proposal = await put(
      `${root}/extensions/package-demo`,
      await authHeaders("owner"),
      nextContent
    );
    expect(proposal.status).toBe(202);
    expect(
      (
        await approve(
          ((await proposal.json()) as { result: { revision_id: string } })
            .result.revision_id
        )
      ).status
    ).toBe(200);
    const response = await put(
      `${root}/extensions/package-demo`,
      await authHeaders("owner"),
      {
        ...nextContent,
        releases: [...nextContent.releases, sampleContent().releases[0]]
      }
    );
    expect(response.status).toBe(409);
  });

  it("publishes a manually selected older release and rejects competing latest flags", async () => {
    const first = await built();
    const newer = await built({ ...manifest(), version: "2.0.0" });
    const payload = {
      ...content(first),
      releases: [
        { ...content(first).releases[0], is_latest: true },
        ...content(newer).releases
      ]
    };
    const conflict = await post(
      `${root}/extensions`,
      await authHeaders("owner"),
      {
        identifier: "package-demo",
        ...payload,
        releases: payload.releases.map((release) => ({
          ...release,
          is_latest: true
        }))
      }
    );
    expect(conflict.status).toBe(409);
    const response = await post(
      `${root}/extensions`,
      await authHeaders("owner"),
      { identifier: "package-demo", ...payload }
    );
    expect(response.status).toBe(201);
    expect(
      (
        await approve(
          ((await response.json()) as { result: { revision_id: string } })
            .result.revision_id
        )
      ).status
    ).toBe(200);
    const version = await get("/extensions/v1/package-demo/version", {});
    expect(await version.text()).toBe("1.0.0");
    expect((await getExtension(db, "package-demo"))!.version).toBe("1.0.0");
  });

  it("keeps production disabled until explicitly enabled with complete storage", async () => {
    env.ENVIRONMENT = "production";
    expect((await upload()).status).toBe(503); // local mode cannot enable production
    Object.assign(env, { EXTENSION_PACKAGES_MODE: "enabled" });
    expect((await upload()).status).toBe(503); // localhost URL / incomplete storage
    env.EXTENSION_PACKAGES_BASE_URL =
      "https://api.fossbilling.net/extensions/v2";
    expect((await upload()).status).toBe(503); // must not fall back to local R2
    Object.assign(env, {
      EXTENSION_PACKAGES_S3_ENDPOINT: "https://s3.example.test",
      EXTENSION_PACKAGES_S3_REGION: "eu-central-003",
      EXTENSION_PACKAGES_S3_BUCKET: "private-packages",
      EXTENSION_PACKAGES_S3_PREFIX: "production",
      EXTENSION_PACKAGES_S3_ACCESS_KEY_ID: "test-key",
      EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY: "test-secret"
    });
    Object.assign(env, {
      EXTENSION_ASSETS_S3_ENDPOINT: "https://s3.example.test",
      EXTENSION_ASSETS_S3_REGION: "eu-central-003",
      EXTENSION_ASSETS_S3_BUCKET: "public-assets",
      EXTENSION_ASSETS_S3_ACCESS_KEY_ID: "test-key",
      EXTENSION_ASSETS_S3_SECRET_ACCESS_KEY: "test-secret",
      EXTENSION_ASSETS_PUBLIC_URL: "https://extensions-assets.fossbilling.net"
    });
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (request: Request) => {
      requests.push(request);
      return new Response(null, { status: 200 });
    });
    const response = await upload(
      manifest(),
      undefined,
      undefined,
      "owner",
      false
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toMatch(
      /^https:\/\/api\.fossbilling\.net\/extensions\/v2\/package-jobs\//
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((request) => request.url.includes("/production/packages/"))
    ).toBe(true);
    Object.assign(env, { EXTENSION_PACKAGES_S3_PREFIX: "local" });
    expect((await upload()).status).toBe(503);
    delete env.EXTENSION_PACKAGES_S3_PREFIX;
    env.ENVIRONMENT = "local";
  });

  it("checks account ownership, upload bounds, invalid archives and disabled storage", async () => {
    expect((await upload(manifest(), new Uint8Array([1, 2, 3]))).status).toBe(
      422
    );
    expect(
      (await upload(manifest(), new Uint8Array(5 * 1024 * 1024 + 1))).status
    ).toBe(413);
    await db
      .prepare("UPDATE users SET deleted_at=CURRENT_TIMESTAMP WHERE id='owner'")
      .run();
    expect((await upload()).status).toBe(403);
    env.EXTENSION_PACKAGES_MODE = "disabled";
    expect((await upload()).status).toBe(503);
  });

  it("leaves failed uploads reserved for cleanup and permits a safe retry", async () => {
    const failure = vi
      .spyOn(bucket(), "put")
      .mockRejectedValueOnce(new Error("storage outage"));
    try {
      expect((await upload()).status).toBe(503);
    } finally {
      failure.mockRestore();
    }
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM package_artifacts")
        .first()
    ).toEqual({ count: 0 });
    expect(
      await db.prepare("SELECT count(*) AS count FROM package_objects").first()
    ).toEqual({ count: 1 });
    expect((await upload()).status).toBe(201);
    expect(
      await db.prepare("SELECT count(*) AS count FROM package_sources").first()
    ).toEqual({ count: 1 });
  });

  it("counts abandoned reservations against quota and safely cleans them after a day", async () => {
    const artifact = await built();
    await db
      .prepare(
        "INSERT INTO package_objects (id,created_by,bytes,created_at) VALUES ('abandoned','owner',?,datetime('now','-2 days'))"
      )
      .bind(512 * 1024 * 1024)
      .run();
    await bucket().put("abandoned", "failed upload");
    expect(
      (
        await upload(
          { ...manifest(), description: "quota test" },
          undefined,
          artifact.source_id
        )
      ).status
    ).toBe(409);
    await insertUser(db, { id: "moderator", is_moderator: 1 });
    const cleanup = await post(
      `${root}/packages/cleanup`,
      await authHeaders("moderator")
    );
    expect(cleanup.status).toBe(200);
    expect(await cleanup.json()).toEqual({ result: { deleted: 1 } });
    expect(await bucket().get("abandoned")).toBeNull();
    expect(
      (
        await upload(
          { ...manifest(), description: "quota test" },
          undefined,
          artifact.source_id
        )
      ).status
    ).toBe(201);
  });
});
