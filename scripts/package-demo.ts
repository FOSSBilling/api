import { v7 as uuidv7 } from "uuid";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { sign } from "hono/jwt";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { PackageArtifactSchema } from "../src/services/extensions/v2/schemas/packages";
import { sha256 } from "../src/services/extensions/v2/package-builder";

const secretsFile = ".dev.vars.packages-local";
const state = ".wrangler/package-demo";
const base = "http://localhost:8789/extensions/v2";
const action = process.argv[2];
const fresh = process.argv.includes("--fresh");
if (action === "setup") {
  try {
    await writeFile(
      secretsFile,
      `ASSERTION_SIGNING_SECRET="${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}"\nGITHUB_TOKEN=""\nEXTENSIONS_REVALIDATE_SECRET=""\n`,
      { flag: "wx", mode: 0o600 }
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  function wrangler(args: string[]) {
    execFileSync(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        ...args,
        "--env",
        "packages-local",
        "--local",
        "--persist-to",
        state
      ],
      {
        stdio: ["pipe", "pipe", "inherit"],
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CI: "true" }
      }
    );
  }
  for (const binding of ["DB_EXTENSIONS", "DB_CENTRAL_ALERTS"])
    wrangler(["d1", "migrations", "apply", binding]);
  wrangler([
    "d1",
    "execute",
    "DB_EXTENSIONS",
    "--command",
    `
    INSERT INTO users (id,name,created_at,updated_at,is_moderator) VALUES
      ('package-demo-owner','Local Package Developer',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,0),
      ('package-demo-reviewer','Local Package Reviewer',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)
      ON CONFLICT DO NOTHING;
    INSERT INTO developers (id,identifier,type,name,owner_user_id,approved_at,created_at,updated_at)
      VALUES ('${uuidv7()}','package-demo-studio','user','Local Package Developer','package-demo-owner',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT DO NOTHING;
  `
  ]);
  console.info(
    "Local package demo initialized. Start npm run packages:dev, then run npm run packages:demo."
  );
} else if (action === "exercise") {
  const secret = (await readFile(secretsFile, "utf8")).match(
    /^ASSERTION_SIGNING_SECRET="([a-f0-9]+)"$/m
  )?.[1];
  if (!secret) throw new Error("Run npm run packages:setup first");
  async function request(
    path: string,
    init: RequestInit = {},
    user?: string
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (user) {
      const now = Math.floor(Date.now() / 1000);
      headers.set(
        "Authorization",
        `Bearer ${await sign({ sub: user, iat: now, exp: now + 60, iss: "fossbilling-extensions", aud: "fossbilling-api/extensions-v2", purpose: "user-authentication", ver: 1 }, secret!, "HS256")}`
      );
    }
    const response = await fetch(`${base}${path}`, { ...init, headers });
    if (path !== "/packages" || response.status !== 202) return response;
    assert.ok(response.headers.get("Location")?.includes("/package-jobs/"));
    let job = (
      (await response.json()) as {
        result: {
          id: string;
          status: string;
          artifact: unknown;
          error: { status: number; message: string } | null;
        };
      }
    ).result;
    assert.equal((await request(`/package-jobs/${job.id}`)).status, 401);
    for (let attempt = 0; attempt < 120; attempt++) {
      if (job.status === "ready")
        return Response.json({ result: job.artifact }, { status: 201 });
      if (job.status === "failed")
        return Response.json(
          { error: job.error },
          { status: job.error?.status ?? 422 }
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = await request(`/package-jobs/${job.id}`, {}, user);
      assert.equal(status.status, 200, await status.clone().text());
      job = ((await status.json()) as { result: typeof job }).result;
    }
    throw new Error(`Package job ${job.id} did not complete locally`);
  }
  const manifest = {
    manifest_version: 1,
    type: "module",
    id: fresh
      ? `package-demo-${crypto.randomUUID().slice(0, 8)}`
      : "directory-package-demo",
    name: "Directory Package Demo",
    version: "0.1.0",
    description: "A locally built extension package",
    author: { name: "Local Package Developer" },
    license: "MIT",
    requires: { fossbilling: ">=0.8.0" }
  };
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
    useCompressionStream: true,
    lastModDate: new Date("1980-01-01T00:00:00Z"),
    extendedTimestamp: false
  });
  await writer.add(
    "Service.php",
    new TextReader("<?php\n// Synthetic local package fixture.\n")
  );
  if (fresh)
    await writer.add(
      "icon.svg",
      new TextReader(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#2563eb" d="M0 0h32v32H0z"/></svg>'
      )
    );
  const source = await writer.close();
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  form.set("source", new File([source], "source.zip"));
  const uploaded = await request(
    "/packages",
    { method: "POST", body: form },
    "package-demo-owner"
  );
  const body = (await uploaded.json()) as { result: unknown };
  assert.equal(uploaded.status, 201, JSON.stringify(body));
  const artifact = PackageArtifactSchema.parse(body.result);
  const privateCheck = await request(`/packages/${artifact.id}/download`);
  if (fresh) assert.equal(privateCheck.status, 404);
  else assert.ok([404, 200].includes(privateCheck.status)); // 200 on a repeat.
  await privateCheck.body?.cancel();
  const iconPath = `/packages/${artifact.id}/icon`;
  if (fresh) assert.equal((await request(iconPath)).status, 404);
  const preview = await request(iconPath, {}, "package-demo-owner");
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("Content-Type"), "image/svg+xml");
  assert.match(preview.headers.get("Cache-Control") ?? "", /private/);
  assert.equal(preview.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(preview.headers.get("Content-Security-Policy") ?? "", /sandbox/);
  await preview.body?.cancel();
  const { id: _id, ...metadata } = artifact.manifest;
  const content = {
    ...metadata,
    readme: "# Directory Package Demo\n\nBuilt and reviewed locally.",
    source: {
      type: "custom",
      repo: "https://example.invalid/local-package-demo"
    },
    download_url: artifact.download_url,
    releases: [
      {
        tag: manifest.version,
        date: "2026-11-05",
        requires: manifest.requires,
        artifact_id: artifact.id,
        sha256: artifact.sha256,
        download_url: artifact.download_url
      }
    ]
  };
  const created = await request(
    "/extensions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: manifest.id, ...content })
    },
    "package-demo-owner"
  );
  let revisionId: string | undefined;
  if (created.status === 201)
    revisionId = ((await created.json()) as { result: { revision_id: string } })
      .result.revision_id;
  else {
    assert.equal(created.status, 409, await created.text());
    const existing = await request(
      `/extensions/${manifest.id}`,
      {},
      "package-demo-owner"
    );
    const listing = (await existing.json()) as {
      result: {
        pending_revision?: { id: string; content: { download_url: string } };
        published?: { download_url: string };
      };
    };
    if (
      listing.result.pending_revision?.content.download_url ===
      artifact.download_url
    )
      revisionId = listing.result.pending_revision.id;
    else
      assert.equal(
        listing.result.published?.download_url,
        artifact.download_url,
        "Existing demo has unrelated changes; it was left untouched"
      );
  }
  if (revisionId) {
    const approved = await request(
      `/extensions/${manifest.id}/revisions/${revisionId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      },
      "package-demo-reviewer"
    );
    assert.equal(approved.status, 200, await approved.text());
  }
  const download = await request(`/packages/${artifact.id}/download`);
  assert.equal(download.status, 200);
  assert.equal(
    await sha256(new Uint8Array(await download.arrayBuffer())),
    artifact.sha256
  );
  const publicIcon = await request(iconPath);
  assert.equal(publicIcon.status, 200);
  assert.equal(publicIcon.headers.get("Content-Type"), "image/svg+xml");
  await publicIcon.body?.cancel();
  const correction = new FormData();
  correction.set(
    "manifest",
    JSON.stringify({
      ...manifest,
      description: "A corrected manifest using the same source ZIP"
    })
  );
  correction.set("source_id", artifact.source_id);
  const corrected = await request(
    "/packages",
    { method: "POST", body: correction },
    "package-demo-owner"
  );
  assert.equal(corrected.status, 201);
  const next = PackageArtifactSchema.parse(
    ((await corrected.json()) as { result: unknown }).result
  );
  assert.equal(next.source_id, artifact.source_id);
  assert.notEqual(next.sha256, artifact.sha256);
  assert.equal((await request(`/packages/${next.id}/download`)).status, 404);
  console.info(
    JSON.stringify(
      {
        publishedPackage: artifact.download_url,
        sha256: artifact.sha256,
        unpublishedCorrection: next.id,
        sourceId: artifact.source_id,
        checks:
          "Private queue status, private package and API preview, approval, public checksum and icon, immutable correction"
      },
      null,
      2
    )
  );
} else {
  throw new Error("Use npm run packages:setup or npm run packages:demo");
}
