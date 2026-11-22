import { PackagingJobsDatabase } from "../../../../src/services/extensions/v2/db/packaging-jobs";
import { processPackagingJob } from "../../../../src/services/extensions/v2/packages/jobs";
import { packagePreparation } from "../../../../src/lib/adapters/cloudflare/packaging-jobs";
import * as dispatch from "../../../../src/lib/adapters/cloudflare/package-dispatcher";
import { prepareQueuedPackage } from "../../../../src/services/extensions/v2/packages/prepare";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
  ZipReader,
  TextWriter
} from "@zip.js/zip.js";
import {
  signAccessToken,
  activateM2mJwks,
  deactivateM2mJwks
} from "../../../lib/auth/m2m-helper";
import {
  PackageArtifactSchema,
  PackageReservationSchema
} from "../../../../src/services/extensions/v2/schemas/packages";
import { ExtensionContentSchema } from "../../../../src/services/extensions/v2/schemas/extensions";
import { contentManifest } from "../../../../src/services/extensions/v2/packages/manifest";
import { sha256 } from "@fossbilling/extension-packaging/checksum";
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
import { wrapD1WithHook } from "./db-interceptor";
import { insertUser, getExtension, getDeveloper, UUID_V7 } from "./db-fixtures";

vi.mock("../../../../src/lib/github-app", async () =>
  (await import("../../../mocks/octokit")).githubClientMock()
);

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
const packageKey = (id: string) => `/test-packages/packages/${id}`;
let b2: ReturnType<typeof mockB2>;
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script/><path d="M0 0h24v24z"/></svg>';
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNQTvnfAAAEOwIHOVGdNAAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);
function mockB2() {
  Object.assign(env, {
    EXTENSION_PACKAGES_S3_ENDPOINT: "https://s3.test-region.backblazeb2.com",
    EXTENSION_PACKAGES_S3_BUCKET: "test-packages",
    EXTENSION_PACKAGES_S3_ACCESS_KEY_ID: "test-key",
    EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY: "test-secret",
    EXTENSION_ASSETS_S3_ENDPOINT: "https://s3.test-region.backblazeb2.com",
    EXTENSION_ASSETS_S3_BUCKET: "test-assets",
    EXTENSION_ASSETS_S3_ACCESS_KEY_ID: "test-key",
    EXTENSION_ASSETS_S3_SECRET_ACCESS_KEY: "test-secret",
    EXTENSION_ASSETS_PUBLIC_URL: "https://extensions-assets.fossbilling.net"
  });
  const calls: Request[] = [];
  const objects = new Map<
    string,
    {
      bytes: ArrayBuffer;
      checksum: string;
      version: string;
    }
  >();
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    calls.push(request.clone());
    const key = url.pathname;
    if (request.method === "PUT") {
      objects.set(key, {
        bytes: await request.arrayBuffer(),
        checksum: request.headers.get("x-amz-meta-sha256")!,
        version: crypto.randomUUID()
      });
      return new Response(null);
    }
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    if (request.method === "DELETE") {
      if (url.searchParams.get("versionId") !== object.version)
        return new Response(null, { status: 400 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405 });
    return new Response(request.method === "HEAD" ? null : object.bytes, {
      headers: {
        "Content-Length": String(object.bytes.byteLength),
        "x-amz-meta-sha256": object.checksum,
        "x-amz-version-id": object.version
      }
    });
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, objects, fetch };
}

const wake = vi.fn<(immediate?: boolean) => Promise<void>>();

beforeEach(async () => {
  wake.mockReset().mockResolvedValue(undefined);
  vi.spyOn(dispatch, "packageDispatcher").mockReturnValue({
    scope: async () => "",
    wake
  });
  b2 = mockB2();
  Object.assign(env, {
    ENVIRONMENT: "local",
    EXTENSION_PACKAGES_MODE: "local",
    EXTENSION_PACKAGES_BASE_URL: "http://localhost:8789/extensions/v2"
  });
  await authHeaders("owner");
  await seedDeveloper("developer", "owner");
});
afterEach(() => {
  const requests = b2.fetch.mock.calls.map(([request]) => request);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of [
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "PUBLIC_URL"
  ])
    Reflect.deleteProperty(env, `EXTENSION_ASSETS_${key}`);
  for (const suffix of [
    "ENDPOINT",
    "BUCKET",
    "ACCESS_KEY_ID",
    "SECRET_ACCESS_KEY"
  ])
    Reflect.deleteProperty(env, `EXTENSION_PACKAGES_S3_${suffix}`);
  Object.assign(env, { EXTENSION_PACKAGES_MODE: "disabled" });
  // Assert outside the adapter's catch, including calls with injected failures.
  for (const request of requests) {
    const url = new URL(request.url);
    expect(url.hostname).toBe("s3.test-region.backblazeb2.com");
    if (url.searchParams.has("X-Amz-Signature")) {
      expect(request.method).toBe("PUT");
      expect(request.headers.get("Authorization")).toBeNull();
    } else {
      expect(request.headers.get("Authorization")).toMatch(
        /^AWS4-HMAC-SHA256 /
      );
    }
    expect(["PUT", "GET", "HEAD", "DELETE"]).toContain(request.method);
    if (request.method === "DELETE")
      expect(url.searchParams.get("versionId")).toBeTruthy();
  }
});
async function zip(
  content = "<?php // source",
  metadata = manifest(),
  icon?: "svg" | "png",
  iconBytes = icon === "png" ? png : new TextEncoder().encode(svg)
) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), options);
  await writer.add("Service.php", new TextReader(content));
  await writer.add("manifest.json", new TextReader(JSON.stringify(metadata)));
  if (icon) await writer.add(`icon.${icon}`, new Uint8ArrayReader(iconBytes));
  return writer.close();
}
async function reserveUpload(
  target: { id?: string; version?: string },
  source: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>
) {
  return post(`${root}/package-uploads`, headers, {
    target: { id: target.id, version: target.version },
    bytes: source.byteLength,
    sha256: await sha256(source)
  });
}
async function prepareUpload(
  target: { id?: string; version?: string },
  source: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>
) {
  const response = await reserveUpload(target, source, headers);
  if (!response.ok) return response;
  const { result } = (await response.json()) as {
    result:
      | {
          kind: "upload";
          id: string;
          url: string;
          headers: Record<string, string>;
        }
      | { kind: "job"; job: { id: string } };
  };
  if (result.kind === "job")
    return Response.json({ result: result.job }, { status: 202 });
  const sent = await fetch(
    new Request(result.url, {
      method: "PUT",
      headers: result.headers,
      body: source
    })
  );
  if (!sent.ok) return new Response(null, { status: 503 });
  return post(`${root}/packages`, headers, { upload_id: result.id });
}
async function upload(
  metadata = manifest(),
  source?: Uint8Array<ArrayBuffer>,
  user = "owner",
  process = true
) {
  const headers = await authHeaders(user);
  const response = await prepareUpload(
    metadata,
    source ?? (await zip(undefined, metadata)),
    headers
  );
  return process ? finishJob(response) : response;
}
async function finishJob(response: Response): Promise<Response> {
  if (response.status !== 202) return response;
  const { result } = (await response.json()) as { result: { id: string } };
  const jobs = new PackagingJobsDatabase(env.DB_EXTENSIONS);
  let job = (await jobs.get(result.id))!;
  for (
    let attempt = 0;
    attempt < 100 && job.status !== "ready" && job.status !== "failed";
    attempt++
  ) {
    await processPackagingJob(jobs, result.id, (job) =>
      prepareQueuedPackage(packagePreparation(env), job)
    );
    job = (await jobs.get(result.id))!;
    if (job.status === "processing")
      await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (job.status === "ready") {
    return get(
      `${root}/packages/${job.artifactId}`,
      await authHeaders("owner")
    );
  }
  return Response.json(
    { error: job.error },
    { status: job.error?.status ?? 503 }
  );
}
async function built(metadata = manifest(), source?: Uint8Array<ArrayBuffer>) {
  const response = await upload(metadata, source);
  const body = (await response.json()) as { result: unknown };
  expect(response.status, JSON.stringify(body)).toBe(200);
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

async function githubPackage(tag = "package-demo-v1.0.0") {
  const github_url = `https://github.com/FOSSBilling/modules/releases/download/${tag}/package.zip`;
  const metadataUrl = `https://api.github.com/repos/fossbilling/modules/releases/tags/${encodeURIComponent(tag)}`;
  const bytes = await zip();
  const checksum = await sha256(bytes);
  const assetUrl =
    "https://api.github.com/repos/fossbilling/modules/releases/assets/123";
  const downloadUrl =
    "https://release-assets.githubusercontent.com/package.zip";
  const download = vi.fn(() => new Response(bytes.slice()));
  const fetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (request.url === downloadUrl) {
        expect(request.headers.get("Authorization")).toBeNull();
        return download();
      }
      if (request.url !== metadataUrl && request.url !== assetUrl)
        return fetch(request);
      expect(request.headers.get("Authorization")).toBe(
        "Bearer public-release-token"
      );
      if (request.url === assetUrl) {
        expect(request.headers.get("Accept")).toBe("application/octet-stream");
        expect(request.headers.get("User-Agent")).toBe(
          "FOSSBilling Extensions"
        );
        return Response.redirect(downloadUrl);
      }
      return Response.json({
        draft: false,
        assets: [
          {
            id: 123,
            name: "package.zip",
            size: bytes.byteLength,
            state: "uploaded",
            digest: `sha256:${checksum}`
          }
        ]
      });
    }
  );
  return { github_url, bytes, checksum, download };
}

it("queues a pinned GitHub asset with a slash in its tag and reuses the ready artifact", async () => {
  const { github_url, checksum, download } = await githubPackage(
    "package-demo/v1.0.0"
  );
  const headers = await authHeaders("owner");
  const importPackage = () =>
    post(`${root}/packages`, headers, { github_url, target: {} });
  const queued = await importPackage();
  expect(queued.status).toBe(202);
  const { result: job } = (await queued.clone().json()) as {
    result: { id: string };
  };
  const result = await finishJob(queued);
  expect(result.status).toBe(200);
  const retry = await importPackage();
  expect(await retry.json()).toMatchObject({
    result: { id: job.id, status: "ready", artifact: { sha256: checksum } }
  });
  expect(download).toHaveBeenCalledOnce();
});

it("rejects a GitHub ZIP that changed without changing size", async () => {
  const { github_url, bytes, download } = await githubPackage();
  const queued = await post(`${root}/packages`, await authHeaders("owner"), {
    github_url,
    target: {}
  });
  expect(queued.status).toBe(202);
  const changed = bytes.slice();
  changed[0] ^= 1;
  download.mockReturnValueOnce(new Response(changed));
  const response = await finishJob(queued);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    error: {
      code: "INVALID_PACKAGE",
      message: expect.stringContaining("checksum")
    }
  });
  expect(
    await db.prepare("SELECT count(*) AS count FROM package_sources").first()
  ).toEqual({ count: 0 });
});

describe("publisher package builds", () => {
  beforeEach(async () => {
    await activateM2mJwks();
    const jwksFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      return new URL(request.url).hostname === "s3.test-region.backblazeb2.com"
        ? b2.fetch(request)
        : jwksFetch(input, init);
    });
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
    const response = await prepareUpload(manifest(), await zip(), {
      Authorization: `Bearer ${await signAccessToken({ clientId: "package-publisher", scopes })}`,
      "Content-Type": "application/json"
    });
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
    const pending = await get(`${root}/packaging-jobs/${job.id}`, headers);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({
      result: { status: "queued", artifact: null }
    });
    expect(
      (await finishJob(Response.json({ result: job }, { status: 202 }))).status
    ).toBe(200);
    const ready = await get(`${root}/packaging-jobs/${job.id}`, headers);
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
    expect(
      (await get(`${root}/packaging-jobs/${job.id}`, headers)).status
    ).toBe(403);
  });
  it("imports and publishes a GitHub asset under the mapped developer", async () => {
    const token = await signAccessToken({
      clientId: "package-publisher",
      scopes: ["extensions:push", "extensions:publish"]
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    };
    const { github_url } = await githubPackage();
    const response = await finishJob(
      await post(`${root}/packages`, headers, {
        github_url,
        target: { id: "package-demo", version: manifest().version }
      })
    );
    expect(response.status).toBe(200);
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
    const original = b2.fetch.getMockImplementation()!;
    b2.fetch.mockImplementationOnce(async (request) => {
      const result = await original(request);
      await db
        .prepare(
          "UPDATE m2m_publisher_clients SET revoked_at=CURRENT_TIMESTAMP WHERE client_id='package-publisher'"
        )
        .run();
      return result;
    });
    expect((await machineBuild()).status).toBe(403);
    expect(
      await db.prepare("SELECT count(*) as count FROM package_sources").first()
    ).toEqual({ count: 0 });
  });
});

describe("queued package preparation", () => {
  it("processes a production burst, including a job submitted by the previous dispatcher", async () => {
    const baseUrl = "https://api.fossbilling.net/extensions/v2";
    Object.assign(env, {
      ENVIRONMENT: "production",
      EXTENSION_PACKAGES_MODE: "enabled",
      EXTENSION_PACKAGES_BASE_URL: baseUrl
    });
    const dispatcher = env.PACKAGE_DISPATCHER.getByName("packaging");
    await runInDurableObject(dispatcher, (instance) => {
      Object.assign(Reflect.get(instance, "env"), env);
    });
    expect(await dispatcher.scope()).toBe("");
    const jobs = new PackagingJobsDatabase(db);
    const ids: string[] = [];
    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
      const response = await upload(
        { ...manifest(), version },
        undefined,
        "owner",
        false
      );
      expect(response.status).toBe(202);
      const { result } = (await response.json()) as { result: { id: string } };
      expect(response.headers.get("Location")).toBe(
        `${baseUrl}/packaging-jobs/${result.id}`
      );
      ids.push(result.id);
    }
    await db
      .prepare(
        "UPDATE package_jobs SET enqueued_at=CURRENT_TIMESTAMP WHERE id=?"
      )
      .bind(ids[0])
      .run();
    for (const id of ids)
      expect(await jobs.get(id)).toMatchObject({
        status: "queued",
        attempts: 0
      });

    // Arm recovery as the hourly cron would for any jobs already in D1.
    await dispatcher.wake();
    for (const id of ids) {
      await runDurableObjectAlarm(dispatcher);
      await expect
        .poll(() => jobs.get(id))
        .toMatchObject({
          status: "ready",
          attempts: 1,
          artifactId: expect.any(String)
        });
    }
    vi.mocked(dispatch.packageDispatcher).mockRestore();
    const response = await get(
      `${root}/packaging-jobs/${ids[0]}`,
      await authHeaders("owner")
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { status: "ready" }
    });
    await runInDurableObject(dispatcher, (_instance, state) =>
      state.storage.deleteAlarm()
    );
  });

  it("validates and stores a Preview ZIP in its scheduled dispatcher", async () => {
    vi.mocked(dispatch.packageDispatcher).mockRestore();
    Object.assign(env, {
      ENVIRONMENT: "preview",
      EXTENSION_PACKAGES_MODE: "enabled",
      EXTENSION_PACKAGES_BASE_URL: "https://api.fossbilling.net/extensions/v2"
    });
    const dispatcher = env.PACKAGE_DISPATCHER.getByName("packaging");
    const other = env.PACKAGE_DISPATCHER.getByName("other-preview");
    await runInDurableObject(dispatcher, (instance) => {
      Object.assign(Reflect.get(instance, "env"), env, {
        ENVIRONMENT: "preview"
      });
    });
    await runInDurableObject(other, (instance) => {
      Object.assign(Reflect.get(instance, "env"), { ENVIRONMENT: "preview" });
    });
    const metadata = manifest();
    const source = await zip(undefined, metadata, "svg");
    const response = await upload(metadata, source, "owner", false);
    expect(response.status).toBe(202);
    const { result: job } = (await response.json()) as {
      result: { id: string };
    };
    expect(new URL(response.headers.get("Location")!).pathname).toBe(
      `${root}/packaging-jobs/${job.id}`
    );
    const jobs = new PackagingJobsDatabase(db, await dispatcher.scope());
    // The upload schedules this alarm. It may already be running by the
    // time the test asks workerd to deliver it.
    await runDurableObjectAlarm(dispatcher);
    await expect
      .poll(() => jobs.get(job.id))
      .toMatchObject({
        status: "ready",
        attempts: 1,
        artifactId: expect.any(String)
      });
    const headers = await authHeaders("owner");
    const status = await get(`${root}/packaging-jobs/${job.id}`, headers);
    expect(status.status).toBe(200);
    const { result } = (await status.json()) as {
      result: { status: string; artifact: unknown };
    };
    expect(result.status).toBe("ready");
    const artifact = PackageArtifactSchema.parse(result.artifact);
    expect(artifact.manifest).toEqual(metadata);
    expect(artifact.sha256).toBe(await sha256(source));
    const download = await get(
      new URL(artifact.download_url).pathname,
      headers
    );
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(source);
    expect(
      [...b2.objects.keys()].some(
        (key) => key.includes("/icons/") && key.endsWith(".svg")
      )
    ).toBe(true);

    vi.spyOn(dispatch, "packageDispatcher").mockReturnValue(other);
    expect(
      (await get(`${root}/packaging-jobs/${job.id}`, headers)).status
    ).toBe(404);
    await runInDurableObject(dispatcher, (_instance, state) =>
      state.storage.deleteAlarm()
    );
  });

  it("recovers a scoped job without an immediate wakeup and retries after a restart", async () => {
    let dispatcher = env.PACKAGE_DISPATCHER.getByName("preview-recovery");
    await runInDurableObject(dispatcher, (instance) => {
      Object.assign(Reflect.get(instance, "env"), env, {
        ENVIRONMENT: "preview"
      });
    });
    const scope = await dispatcher.scope();
    vi.mocked(dispatch.packageDispatcher).mockReturnValue({
      scope: async () => scope,
      wake
    });
    // Leave recovery armed and simulate losing the immediate wakeup.
    await dispatcher.wake();
    const response = await upload(manifest(), undefined, "owner", false);
    expect(response.status).toBe(202);
    const { result } = (await response.json()) as { result: { id: string } };
    const jobs = new PackagingJobsDatabase(db, scope);
    const job = (await jobs.get(result.id))!;
    const key = packageKey(job.uploadObjectId!);
    const staged = b2.objects.get(key)!;
    b2.objects.delete(key);
    expect(await runDurableObjectAlarm(dispatcher)).toBe(true);
    expect(await jobs.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      error: { code: "SOURCE_UNAVAILABLE" }
    });
    const retryAt = await runInDurableObject(dispatcher, (_instance, state) =>
      state.storage.getAlarm()
    );
    expect(retryAt).toBeGreaterThan(Date.now());
    await expect(
      runInDurableObject(dispatcher, (_instance, state) =>
        state.abort("test restart")
      )
    ).rejects.toThrow();
    dispatcher = env.PACKAGE_DISPATCHER.getByName("preview-recovery");
    await runInDurableObject(dispatcher, (instance) => {
      Object.assign(Reflect.get(instance, "env"), env, {
        ENVIRONMENT: "preview"
      });
    });
    expect(
      await runInDurableObject(dispatcher, (_instance, state) =>
        state.storage.getAlarm()
      )
    ).toBe(retryAt);
    expect(await dispatcher.scope()).toBe(scope);

    b2.objects.set(key, staged);
    await db
      .prepare(
        "UPDATE package_jobs SET updated_at=datetime('now','-61 seconds') WHERE id=?"
      )
      .bind(job.id)
      .run();
    expect(await runDurableObjectAlarm(dispatcher)).toBe(true);
    expect(await jobs.get(job.id)).toMatchObject({
      status: "ready",
      attempts: 2
    });
    await runInDurableObject(dispatcher, (_instance, state) =>
      state.storage.deleteAlarm()
    );
  });

  it("rejects a version-only target before reserving storage", async () => {
    const response = await reserveUpload(
      { version: manifest().version },
      await zip(),
      await authHeaders("owner")
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: [
          {
            path: ["target", "id"],
            message: "Extension ID is required when a version is supplied"
          }
        ]
      }
    });
    expect(
      await db.prepare("SELECT count(*) AS count FROM package_objects").first()
    ).toEqual({ count: 0 });
  });

  it("reuses an active reservation without extending its expiry", async () => {
    const source = await zip();
    const headers = await authHeaders("owner");
    const reserve = async () => {
      const response = await reserveUpload(manifest(), source, headers);
      expect(response.status).toBe(200);
      const { result } = await response.json<{ result: unknown }>();
      const reservation = PackageReservationSchema.parse(result);
      if (reservation.kind !== "upload")
        throw new Error("Expected a source upload reservation");
      return reservation;
    };
    const original = await reserve();
    const setExpiry = db.prepare(
      "UPDATE package_uploads SET expires_at=? WHERE id=?"
    );
    await setExpiry.bind(Math.floor(Date.now() / 1000) + 60, original.id).run();
    const retry = await reserve();
    expect(retry.id).toBe(original.id);
    const remaining = Number(
      new URL(retry.url).searchParams.get("X-Amz-Expires")
    );
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60);
    expect(
      await db.prepare("SELECT count(*) as count FROM package_objects").first()
    ).toEqual({ count: 1 });

    await setExpiry.bind(0, original.id).run();
    const replacement = await reserve();
    expect(replacement.id).not.toBe(original.id);
  });

  it("confirms only a reserved object with the expected bytes and checksum", async () => {
    const source = await zip();
    const headers = await authHeaders("owner");
    const reserve = await reserveUpload(manifest(), source, headers);
    expect(reserve.status).toBe(200);
    const { result } = (await reserve.json()) as {
      result: { id: string; url: string; headers: Record<string, string> };
    };
    const uploadUrl = new URL(result.url);
    const uploadHeaders = new Headers(result.headers);
    expect(
      uploadUrl.searchParams.get("X-Amz-SignedHeaders")?.split(";")
    ).toEqual(
      expect.arrayContaining(["content-length", "x-amz-checksum-sha256"])
    );
    expect(uploadHeaders.has("Content-Length")).toBe(false);
    const confirm = (actor = headers) =>
      post(`${root}/packages`, actor, { upload_id: result.id });
    expect((await confirm(await authHeaders("stranger"))).status).toBe(404);
    expect((await confirm()).status).toBe(409);
    await fetch(
      new Request(result.url, {
        method: "PUT",
        headers: result.headers,
        body: source
      })
    );
    const object = b2.objects.get(packageKey(result.id))!;
    const correctBytes = object.bytes;
    object.bytes = correctBytes.slice(1);
    expect((await confirm()).status).toBe(409);
    object.bytes = correctBytes;
    const correctChecksum = object.checksum;
    object.checksum = "0".repeat(64);
    expect((await confirm()).status).toBe(409);
    object.checksum = correctChecksum;
    const first = await confirm();
    expect(first.status).toBe(202);
    const repeat = await confirm();
    expect(await repeat.json()).toEqual(await first.json());
    await db
      .prepare(
        "UPDATE developers SET ownership_epoch=ownership_epoch+1 WHERE identifier='developer'"
      )
      .run();
    expect((await confirm()).status).toBe(404);
  });
  it("accepts a private job without preparing an artifact and deduplicates retries", async () => {
    const source = await zip();
    const response = await upload(manifest(), source, "owner", false);
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
    expect(wake.mock.calls).toEqual([[], [true]]);
    const repeat = await upload(manifest(), source, "owner", false);
    expect(
      ((await repeat.json()) as { result: { id: string } }).result.id
    ).toBe(job.id);
    expect((await get(`${root}/packaging-jobs/${job.id}`, {})).status).toBe(
      401
    );
    expect(
      (
        await get(
          `${root}/packaging-jobs/${job.id}`,
          await authHeaders("stranger")
        )
      ).status
    ).toBe(403);
    expect(
      (await finishJob(Response.json({ result: job }, { status: 202 }))).status
    ).toBe(200);
    const status = await get(
      `${root}/packaging-jobs/${job.id}`,
      await authHeaders("owner")
    );
    expect(
      ((await status.json()) as { result: { status: string } }).result.status
    ).toBe("ready");
  });
  it("does not process a job after its developer ownership changes", async () => {
    const response = await upload(manifest(), undefined, "owner", false);
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
  it("keeps a job recoverable if the immediate wakeup fails", async () => {
    wake
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("dispatcher unavailable"));
    const source = await zip();
    expect((await upload(manifest(), source, "owner", false)).status).toBe(503);
    const jobs = new PackagingJobsDatabase(db);
    const pending = await jobs.nextForAlarm();
    expect(pending).not.toBeNull();

    const retry = await upload(manifest(), source, "owner", false);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ result: { id: pending!.id } });
    expect(wake).toHaveBeenLastCalledWith(true);
  });
  it("retries a missing staged upload and completes when storage recovers", async () => {
    const source = await zip();
    const response = await upload(manifest(), source, "owner", false);
    const { result } = (await response.json()) as { result: { id: string } };
    const jobs = new PackagingJobsDatabase(db);
    const job = (await jobs.get(result.id))!;
    const key = packageKey(job.uploadObjectId!);
    const staged = b2.objects.get(key)!;
    b2.objects.delete(key);
    expect(
      await processPackagingJob(jobs, job.id, (job) =>
        prepareQueuedPackage(packagePreparation(env), job)
      )
    ).toBe("retry");
    expect(await jobs.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      error: { code: "SOURCE_UNAVAILABLE", status: 503 }
    });
    b2.objects.set(key, staged);
    expect(
      await processPackagingJob(jobs, job.id, (job) =>
        prepareQueuedPackage(packagePreparation(env), job)
      )
    ).toBe("ack");
    expect(await jobs.get(job.id)).toMatchObject({
      status: "ready",
      attempts: 2,
      error: null
    });
  });
  it("recovers an expired processing lease without accepting stale completion", async () => {
    const response = await upload(manifest(), undefined, "owner", false);
    const { result: job } = (await response.json()) as {
      result: { id: string };
    };
    const jobs = new PackagingJobsDatabase(db);
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
    const artifactId = await prepareQueuedPackage(
      packagePreparation(env),
      claimed!
    );
    await jobs.complete(job.id, "second", artifactId);
    expect((await jobs.get(job.id))!.status).toBe("ready");
  });
  it("claims a job once across concurrent deliveries", async () => {
    const response = await upload(manifest(), undefined, "owner", false);
    const { result: job } = (await response.json()) as {
      result: { id: string };
    };
    const jobs = new PackagingJobsDatabase(db);
    const prepare = vi.fn(
      (
        job: import("../../../../src/services/extensions/v2/packages/jobs").PackagingJob
      ) => prepareQueuedPackage(packagePreparation(env), job)
    );
    await Promise.all([
      processPackagingJob(jobs, job.id, prepare),
      processPackagingJob(jobs, job.id, prepare)
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await jobs.get(job.id))!.status).toBe("ready");
  });
});

describe("stored directory packages", () => {
  it("stores the validated ZIP and prepared icon in their configured B2 buckets", async () => {
    const source = await iconSource();
    const artifact = await built(manifest(), source);
    const objects = (await db
      .prepare(
        "SELECT a.object_id, i.svg_object_id FROM package_artifacts a JOIN package_icons i ON a.source_id=i.source_id WHERE a.id=?"
      )
      .bind(artifact.id)
      .first<{ object_id: string; svg_object_id: string }>())!;
    const archive = b2.objects.get(packageKey(objects.object_id));
    expect(archive && new Uint8Array(archive.bytes)).toEqual(source);
    const asset = b2.objects.get(`/test-assets/${objects.svg_object_id}`);
    const sanitized = new TextDecoder().decode(asset?.bytes);
    expect(sanitized).toContain("<path");
    expect(sanitized).not.toContain("<script");
  });

  it("keeps uploads private until approval and publishes the exact reviewed ZIP", async () => {
    const source = await zip();
    const response = await prepareUpload(
      {},
      source,
      await authHeaders("owner")
    );
    expect(response.status).toBe(202);
    const initial = await response.json<{
      result: { extension_identifier: string | null };
    }>();
    expect(initial.result.extension_identifier).toBeNull();
    const prepared = await finishJob(Response.json(initial, { status: 202 }));
    const { result } = await prepared.json<{ result: unknown }>();
    const artifact = PackageArtifactSchema.parse(result);
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
    expect(bytes).toEqual(source);
    expect(artifact.sha256).toBe(await sha256(source));
    expect(artifact.manifest).toEqual(manifest());
    await db
      .prepare(
        "UPDATE package_objects SET created_at=datetime('now','-2 days')"
      )
      .run();
    const cleanup = await post(
      `${root}/packages/cleanup`,
      await authHeaders("moderator")
    );
    expect(await cleanup.json()).toEqual({ result: { deleted: 1 } });
    expect((await get(path, {})).status).toBe(200);
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
    const artifact = await built(manifest(), await iconSource());
    const path = `${root}/packages/${artifact.id}/icon`;
    expect((await get(path, {})).status).toBe(404);
    expect((await get(path, await authHeaders("stranger"))).status).toBe(404);
    const preview = await get(path, await authHeaders("owner"));
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(preview.headers.get("Content-Security-Policy")).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    );
    expect(preview.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await preview.text()).toContain("<path");
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
    const object = await db
      .prepare("SELECT object_id FROM package_artifacts WHERE id=?")
      .bind(artifact.id)
      .first<{ object_id: string }>();
    b2.objects.delete(packageKey(object!.object_id));
    // Reading the icon must not depend on opening the ZIP.
    expect((await get(path, await authHeaders("owner"))).status).toBe(200);
    expect((await approve(await submitted(artifact))).status).toBe(200);
    expect((await get(path, {})).status).toBe(200);
    const published = await getExtension(db, "package-demo");
    expect(published?.icon_url).toBe(
      `https://extensions-assets.fossbilling.net/${String(before!.svg_object_id)}`
    );
    await db
      .prepare(
        "UPDATE extensions SET delisted_at=CURRENT_TIMESTAMP WHERE identifier='package-demo'"
      )
      .run();
    expect((await get(path, {})).status).toBe(404);
  });
  it("serves prepared AVIF or PNG according to the visitor's Accept header", async () => {
    const artifact = await built(manifest(), await iconSource("png"));
    const path = `${root}/packages/${artifact.id}/icon`;
    const headers = await authHeaders("owner");
    const response = await get(path, headers);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer()).slice(0, 8)).toEqual(
      png.slice(0, 8)
    );
    const preferred = await get(path, {
      ...headers,
      Accept: "image/avif,image/png"
    });
    expect(preferred.headers.get("Content-Type")).toBe("image/avif");
    const signature = (await preferred.arrayBuffer()).slice(4, 12);
    expect(new TextDecoder().decode(signature)).toBe("ftypavif");
    const excluded = await get(path, {
      ...headers,
      Accept: "image/avif;q=0,image/png"
    });
    expect(excluded.headers.get("Content-Type")).toBe("image/png");
  });

  it("lets moderators correct directory descriptions without changing the published ZIP", async () => {
    const artifact = await built();
    expect((await approve(await submitted(artifact))).status).toBe(200);
    const description = "Moderator correction";
    const response = await post(
      `${root}/extensions/package-demo/moderator-correct`,
      await authHeaders("moderator"),
      {
        ...content(artifact),
        description,
        correction_note: "Correct the listing"
      }
    );
    expect(response.status).toBe(200);
    const extension = (await getExtension(db, "package-demo"))!;
    expect(extension.description).toBe(description);
    expect(JSON.parse(extension.releases!)[0].artifact_id).toBe(artifact.id);
    const download = await get(`${root}/packages/${artifact.id}/download`, {});
    const files = await unpack(new Uint8Array(await download.arrayBuffer()));
    expect(JSON.parse(files["manifest.json"]).description).toBe(
      artifact.manifest.description
    );
  });

  it("rejects an invalid icon without reserving the source version", async () => {
    const invalidIcon = new TextEncoder().encode("not an SVG");
    const source = await zip(undefined, manifest(), "svg", invalidIcon);
    const response = await upload(manifest(), source);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_ICON" }
    });
    expect(
      await db.prepare("SELECT count(*) AS count FROM package_sources").first()
    ).toEqual({ count: 0 });
    expect((await upload()).status).toBe(200);
  });

  const iconSource = (format: "svg" | "png" = "svg") =>
    zip(undefined, manifest(), format);
  it("stores pending icons using the permanent draft UUID and publishes local asset URLs in development", async () => {
    Object.assign(env, {
      ENVIRONMENT: "development",
      EXTENSION_ASSETS_PUBLIC_URL:
        "http://127.0.0.1:8787/cdn-cgi/local/r2/public/extension-assets-local"
    });
    const artifact = await built(manifest(), await iconSource());
    const draft = (await getExtension(db, "package-demo"))!;
    expect(draft.id).toMatch(UUID_V7);
    expect(draft.published_at).toBeNull();
    expect(
      (await get(`${root}/extensions/package-demo`, await authHeaders("owner")))
        .status
    ).toBe(200);
    expect((await get(`${root}/extensions/package-demo`, {})).status).toBe(404);
    const uploads = b2.calls.filter(
      (r) =>
        r.method === "PUT" &&
        new URL(r.url).pathname.startsWith("/test-assets/")
    );
    expect(uploads).toHaveLength(1);
    const upload = uploads[0];
    const objectKey = new URL(upload.url).pathname.replace("/test-assets/", "");
    expect(objectKey).toMatch(
      new RegExp(`^extensions/${draft.id}/icons/[a-f0-9-]{36}\\.svg$`)
    );
    const callsBefore = b2.calls.length;
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
    expect(b2.calls).toHaveLength(callsBefore);
    const preview = await get(
      `${root}/packages/${artifact.id}/icon`,
      await authHeaders("owner")
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await preview.text()).toContain("<svg");
    expect(b2.calls.at(-1)?.url).toBe(upload.url);
    const pending = await submitted(artifact);
    const callsBeforeApproval = b2.calls.length;
    expect((await approve(pending)).status).toBe(200);
    const published = (await getExtension(db, "package-demo"))!;
    expect(published.id).toBe(draft.id);
    expect(published.icon_url).toBe(
      `${env.EXTENSION_ASSETS_PUBLIC_URL}/${objectKey}`
    );
    expect(b2.calls).toHaveLength(callsBeforeApproval);
    const update = await put(
      `${root}/extensions/package-demo`,
      await authHeaders("owner"),
      { ...content(artifact), description: "Updated listing description" }
    );
    expect(update.status).toBe(202);
    const { result } = (await update.json()) as {
      result: { revision_id: string };
    };
    expect((await approve(result.revision_id)).status).toBe(200);
    expect((await getExtension(db, "package-demo"))?.icon_url).toBe(
      published.icon_url
    );
    expect(
      b2.calls.filter(
        (r) =>
          r.method === "PUT" &&
          new URL(r.url).pathname.startsWith("/test-assets/")
      )
    ).toHaveLength(1);
  });

  it("fails preparation on asset upload errors and retries without changing storage backends", async () => {
    const source = await iconSource();
    const original = b2.fetch.getMockImplementation()!;
    b2.fetch.mockImplementation(async (request) =>
      request.method === "PUT" &&
      new URL(request.url).pathname.startsWith("/test-assets/")
        ? new Response(null, { status: 503 })
        : original(request)
    );
    expect((await upload(manifest(), source)).status).toBe(503);
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM package_artifacts")
        .first()
    ).toEqual({ count: 0 });
    b2.fetch.mockImplementation(original);
    const artifact = await built(manifest(), source);
    const download = await get(
      `${root}/packages/${artifact.id}/download`,
      await authHeaders("owner")
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(source);
    const stored = await db
      .prepare(
        "SELECT s.object_id = a.object_id AS shares_zip FROM package_sources s JOIN package_artifacts a ON a.source_id=s.id WHERE a.id=?"
      )
      .bind(artifact.id)
      .first();
    expect(stored).toEqual({ shares_zip: 1 });
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
    const artifact = await built(manifest(), await iconSource("png"));
    const packageRequests = b2.calls.filter((request) =>
      new URL(request.url).pathname.startsWith("/test-packages/")
    );
    // The browser uploads the source, the API confirms it, and the job seals the ZIP.
    expect(packageRequests.length).toBeLessThanOrEqual(4);
    expect((await approve(await submitted(artifact))).status).toBe(200);
    const uploads = b2.calls.filter(
      (request) =>
        request.method === "PUT" &&
        new URL(request.url).pathname.startsWith("/test-assets/")
    );
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
        "https://s3.test-region.backblazeb2.com/test-assets",
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

  it("rejects metadata/requirements/URL/checksum mismatches at submission", async () => {
    const artifact = await built();
    for (const patch of [
      { name: "Not in ZIP" },
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

  it("allows a pending ZIP replacement and locks the reviewed version on publication", async () => {
    const first = await built();
    const revision = await submitted(first);
    const replacementBytes = await zip("<?php // replacement");
    const replacement = await built(manifest(), replacementBytes);
    expect(replacement.sha256).not.toBe(first.sha256);
    const replaced = await put(
      `${root}/extensions/package-demo/revisions/${revision}`,
      await authHeaders("owner"),
      content(replacement)
    );
    expect(replaced.status).toBe(202);
    expect((await approve(revision)).status).toBe(404);
    const { result } = await replaced.json<{
      result: { revision_id: string };
    }>();
    expect((await approve(result.revision_id)).status).toBe(200);
    expect(
      (await get(`${root}/packages/${first.id}/download`, {})).status
    ).toBe(404);
    const download = await get(
      `${root}/packages/${replacement.id}/download`,
      {}
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(
      replacementBytes
    );
    expect(
      (await upload(manifest(), await zip("<?php // another upload"))).status
    ).toBe(409);
    expect(
      (
        await put(
          `${root}/extensions/package-demo`,
          await authHeaders("owner"),
          content(first)
        )
      ).status
    ).toBe(409);
    expect((await built(manifest(), replacementBytes)).id).toBe(replacement.id);
  });

  it("locks a version even when two moderator corrections pass the preflight check", async () => {
    const original = await built();
    expect((await approve(await submitted(original))).status).toBe(200);
    const metadata = { ...manifest(), version: "1.1.0" };
    const winningBytes = await zip("<?php // first correction", metadata);
    const winner = await built(metadata, winningBytes);
    const loser = await built(
      metadata,
      await zip("<?php // second correction", metadata)
    );
    const headers = await authHeaders("moderator");
    const path = `${root}/extensions/package-demo/moderator-correct`;
    const correct = (artifact: typeof winner) =>
      post(path, headers, {
        ...content(artifact),
        correction_note: "Publish reviewed release"
      });
    env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
      if (
        sql.includes("UPDATE extensions") &&
        sql.includes("published_revision_id = ?")
      ) {
        env.DB_EXTENSIONS = db;
        expect((await correct(winner)).status).toBe(200);
      }
    });
    const stale = await correct(loser);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: {
        message: "Published release ZIPs are locked; upload a new version"
      }
    });
    const download = await get(`${root}/packages/${winner.id}/download`, {});
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(winningBytes);
    expect(
      (await get(`${root}/packages/${loser.id}/download`, {})).status
    ).toBe(404);
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
    const headers = await authHeaders("owner");
    const prepared = vi.spyOn(db, "prepare");
    const response = await post(`${root}/extensions`, headers, {
      identifier: "package-demo",
      ...content(artifact),
      releases
    });
    const artifactQueries = prepared.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes("FROM package_artifacts"));
    prepared.mockRestore();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { message: "Release does not match its package artifact" }
    });
    // Keep validation bounded rather than querying once per release.
    expect(artifactQueries.length).toBeLessThanOrEqual(2);
    expect(
      (
        await post(`${root}/extensions`, headers, {
          identifier: "package-demo",
          ...content(artifact)
        })
      ).status
    ).toBe(201);
  });
  it("revalidates the artifact at approval rather than trusting submission-time checks", async () => {
    const artifact = await built();
    const revision = await submitted(artifact);
    await db
      .prepare(
        "UPDATE extension_revisions SET content=json_set(content,'$.name','Changed after submission') WHERE id=?"
      )
      .bind(revision)
      .run();
    expect((await approve(revision)).status).toBe(409);
    expect(
      (await get(`${root}/packages/${artifact.id}/download`, {})).status
    ).toBe(404);
  });

  it("rejects downloads when the stored checksum metadata changes", async () => {
    const artifact = await built();
    const stored = await db
      .prepare("SELECT object_id FROM package_artifacts WHERE id=?")
      .bind(artifact.id)
      .first<{ object_id: string }>();
    b2.objects.get(packageKey(stored!.object_id))!.checksum = "0".repeat(64);
    expect(
      (
        await get(
          `${root}/packages/${artifact.id}/download`,
          await authHeaders("owner")
        )
      ).status
    ).toBe(503);
  });

  it("concurrent identical uploads share one reservation, source and artifact", async () => {
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
    ).toEqual({ count: 2 }); // staging upload and the sealed archive
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
    Reflect.deleteProperty(env, "EXTENSION_PACKAGES_S3_BUCKET");
    expect((await upload()).status).toBe(503);
    Object.assign(env, { EXTENSION_PACKAGES_S3_BUCKET: "production-packages" });
    Reflect.deleteProperty(env, "EXTENSION_ASSETS_S3_SECRET_ACCESS_KEY");
    expect((await upload()).status).toBe(503);
    Object.assign(env, {
      EXTENSION_ASSETS_S3_SECRET_ACCESS_KEY: "test-secret"
    });
    const requests = b2.calls;
    const response = await upload(manifest(), undefined, "owner", false);
    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toMatch(
      /^https:\/\/api\.fossbilling\.net\/extensions\/v2\/packaging-jobs\//
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((request) =>
        new URL(request.url).pathname.startsWith(
          "/production-packages/packages/"
        )
      )
    ).toBe(true);
  });

  it("admits a small package with 30 MiB of remaining storage headroom", async () => {
    await db
      .prepare(
        "INSERT INTO package_objects (id,created_by,bytes) VALUES (?,'owner',?)"
      )
      .bind(crypto.randomUUID(), 482 * 1024 * 1024)
      .run();
    expect((await upload()).status).toBe(200);
  });

  it("checks account ownership, upload bounds, processor rejection and disabled storage", async () => {
    expect((await upload(manifest(), new Uint8Array([1, 2, 3]))).status).toBe(
      422
    );
    expect(
      (await upload(manifest(), new Uint8Array(5 * 1024 * 1024 + 1))).status
    ).toBe(413);
    Reflect.deleteProperty(env, "EXTENSION_PACKAGES_S3_ENDPOINT");
    expect((await upload()).status).toBe(503);
    Object.assign(env, {
      EXTENSION_PACKAGES_S3_ENDPOINT: "https://s3.test-region.backblazeb2.com"
    });
    await db
      .prepare("UPDATE users SET deleted_at=CURRENT_TIMESTAMP WHERE id='owner'")
      .run();
    expect((await upload()).status).toBe(403);
    Object.assign(env, { EXTENSION_PACKAGES_MODE: "disabled" });
    expect((await upload()).status).toBe(503);
  });

  it("leaves failed uploads reserved for cleanup and permits a safe retry", async () => {
    b2.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await upload()).status).toBe(503);
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM package_artifacts")
        .first()
    ).toEqual({ count: 0 });
    expect(
      await db.prepare("SELECT count(*) AS count FROM package_objects").first()
    ).toEqual({ count: 1 });
    expect((await upload()).status).toBe(200);
    expect(
      await db.prepare("SELECT count(*) AS count FROM package_sources").first()
    ).toEqual({ count: 1 });
  });

  it("counts abandoned reservations against quota and safely cleans them after a day", async () => {
    const abandoned = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO package_objects (id,created_by,bytes,created_at) VALUES (?,'owner',?,datetime('now','-2 days'))"
      )
      .bind(abandoned, 512 * 1024 * 1024)
      .run();
    const bytes = new Uint8Array(new TextEncoder().encode("failed upload"));
    b2.objects.set(packageKey(abandoned), {
      bytes: bytes.buffer,
      checksum: await sha256(bytes),
      version: "abandoned-version"
    });
    expect((await upload()).status).toBe(409);
    await insertUser(db, { id: "moderator", is_moderator: 1 });
    const cleanup = await post(
      `${root}/packages/cleanup`,
      await authHeaders("moderator")
    );
    expect(cleanup.status).toBe(200);
    expect(await cleanup.json()).toEqual({ result: { deleted: 1 } });
    expect(b2.objects.has(packageKey(abandoned))).toBe(false);
    expect(
      b2.calls.find((request) => request.method === "DELETE")?.url
    ).toContain("versionId=abandoned-version");
    expect((await upload()).status).toBe(200);
  });
});
