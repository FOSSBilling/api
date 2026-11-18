import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { URL } from "node:url";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import { b2ObjectStore } from "@fossbilling/extension-packaging/adapters/b2";
import { sha256 } from "@fossbilling/extension-packaging/checksum";

let server: Unstable_DevWorker;
const defaults = parseEnv(
  readFileSync(
    new URL(
      "../../../libraries/extension-packaging/development.env",
      import.meta.url
    ),
    "utf8"
  )
);
beforeAll(async () => {
  server = await unstable_dev("scripts/local-storage.ts", {
    config: "wrangler.local-storage.jsonc",
    envFiles: ["../../libraries/extension-packaging/development.env"],
    ip: "127.0.0.1",
    port: 0,
    persist: false,
    logLevel: "error",
    experimental: { disableExperimentalWarning: true }
  });
}, 30000);
afterAll(async () => {
  await server?.stop();
});

it("shares local S3 objects between clients, serves icons and removes objects on cleanup", async () => {
  const env = { ...defaults };
  for (const name of [
    "EXTENSION_PACKAGES_S3_ENDPOINT",
    "EXTENSION_ASSETS_S3_ENDPOINT",
    "EXTENSION_ASSETS_PUBLIC_URL"
  ]) {
    const url = new URL(env[name] ?? "");
    url.port = String(server.port);
    env[name] = url.href;
  }
  const getEnv = (name: string) => env[name];
  const writer = b2ObjectStore(getEnv, "packages");
  const reader = b2ObjectStore(getEnv, "packages");
  const id = crypto.randomUUID();
  const zip = new Uint8Array(new TextEncoder().encode("synthetic ZIP bytes"));
  const checksum = await sha256(zip);
  await writer.put(id, zip, checksum);
  expect(
    new Uint8Array(
      await new Response(await reader.get(id, checksum)).arrayBuffer()
    )
  ).toEqual(zip);

  const assets = b2ObjectStore(getEnv, "assets");
  const key = `extensions/${crypto.randomUUID()}/icons/${id}.svg`;
  const icon = new Uint8Array(
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
  );
  await assets.put(key, icon, await sha256(icon));
  const publicUrl = `${env.EXTENSION_ASSETS_PUBLIC_URL}/${key}`;
  const response = await fetch(publicUrl);
  expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(icon);

  await writer.delete(id);
  await assets.delete(key);
  expect(await reader.get(id)).toBeNull();
  expect(await assets.get(key)).toBeNull();
  expect((await fetch(publicUrl)).status).toBe(404);
});
