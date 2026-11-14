import { afterEach, describe, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";
import { prepareDeployment } from "../scripts/prepare-deployment";

const service = fileURLToPath(new URL("../", import.meta.url));
const resources = {
  DB_EXTENSIONS: "11111111-1111-4111-8111-111111111111",
  DB_CENTRAL_ALERTS: "22222222-2222-4222-8222-222222222222",
  AUTH_KV: "a".repeat(32),
  CACHE_KV: "b".repeat(32),
  DOWNLOAD_BUCKET: "api-staging"
};
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "api-deployment-"));
  folders.push(folder);
  copyFileSync(join(service, "wrangler.jsonc"), join(folder, "wrangler.jsonc"));
  symlinkSync(join(service, "src"), join(folder, "src"), "dir");
  return folder;
}
const read = (folder: string, file: string) =>
  JSON.parse(readFileSync(join(folder, "dist", file), "utf8"));

describe("API deployment artifact", () => {
  it("keeps production and Preview targets separate and packages the exact SQL used by both", () => {
    const folder = fixture();
    const source: Unstable_RawConfig = experimental_readRawConfig({
      config: join(folder, "wrangler.jsonc")
    }).rawConfig;
    prepareDeployment(folder, JSON.stringify(resources));
    const artifact = read(folder, "wrangler.json");
    expect(artifact.main).toBe("index.js");
    expect(artifact.no_bundle).toBe(true);
    expect(
      artifact.d1_databases.map((db: { database_id: string }) => db.database_id)
    ).toEqual(source.d1_databases!.map((db) => db.database_id));
    expect(
      artifact.previews.d1_databases.map(
        (db: { binding: string; database_id: string }) => [
          db.binding,
          db.database_id
        ]
      )
    ).toEqual(
      source.d1_databases!.map((db) => [
        db.binding,
        resources[db.binding as "DB_EXTENSIONS" | "DB_CENTRAL_ALERTS"]
      ])
    );
    expect(
      read(folder, "wrangler.preview-migrations.json").d1_databases
    ).toEqual(artifact.previews.d1_databases);
    expect(artifact.previews.kv_namespaces).toEqual([
      { binding: "AUTH_KV", id: resources.AUTH_KV },
      { binding: "CACHE_KV", id: resources.CACHE_KV }
    ]);
    expect(artifact.previews.r2_buckets).toEqual([
      { binding: "DOWNLOAD_BUCKET", bucket_name: resources.DOWNLOAD_BUCKET }
    ]);
    expect(artifact.previews.services).toEqual([]);
    expect(artifact.services).toEqual(source.services);
    expect(artifact.previews.vars.EXTENSIONS_FRONTEND_URL).toBe(
      "https://staging-extensions.fossbilling.workers.dev"
    );
    expect(artifact.previews.vars.EXTENSION_PACKAGES_MODE).toBe("disabled");
    for (const database of source.d1_databases!) {
      const packaged = artifact.d1_databases.find(
        (db: { binding: string }) => db.binding === database.binding
      );
      const original = join(service, database.migrations_dir!);
      const copied = join(folder, "dist", packaged.migrations_dir);
      const sql = readdirSync(original)
        .filter((name) => name.endsWith(".sql"))
        .sort();
      expect(readdirSync(copied).sort()).toEqual(sql);
      for (const name of sql)
        expect(readFileSync(join(copied, name))).toEqual(
          readFileSync(join(original, name))
        );
    }
    // Rebuilding without Preview resources cannot reuse a stale migration target.
    prepareDeployment(folder);
    expect(
      existsSync(join(folder, "dist/wrangler.preview-migrations.json"))
    ).toBe(false);
    expect(read(folder, "wrangler.json").previews.d1_databases).toBeUndefined();
  });
  it("rejects production resources and duplicated staging IDs before writing an artifact", () => {
    const folder = fixture();
    const source: Unstable_RawConfig = experimental_readRawConfig({
      config: join(folder, "wrangler.jsonc")
    }).rawConfig;
    const overrides = [
      { DB_EXTENSIONS: source.d1_databases![0].database_id },
      { DB_EXTENSIONS: source.d1_databases![0].database_id!.toUpperCase() },
      { DB_EXTENSIONS: resources.DB_CENTRAL_ALERTS },
      { AUTH_KV: source.kv_namespaces![0].id },
      { CACHE_KV: source.kv_namespaces![1].id },
      { DOWNLOAD_BUCKET: source.r2_buckets![0].bucket_name },
      { AUTH_KV: resources.CACHE_KV }
    ];
    for (const override of overrides) {
      expect(() =>
        prepareDeployment(folder, JSON.stringify({ ...resources, ...override }))
      ).toThrow(
        "API_PREVIEW_RESOURCES must use distinct non-production resources"
      );
      expect(existsSync(join(folder, "dist/wrangler.json"))).toBe(false);
    }
  });
});
