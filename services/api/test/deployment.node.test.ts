import { afterEach, describe, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";
import { prepareDeployment } from "../scripts/prepare-deployment";

const service = fileURLToPath(new URL("../", import.meta.url));
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
function fixture(update?: (config: Unstable_RawConfig) => void) {
  const folder = mkdtempSync(join(tmpdir(), "api-deployment-"));
  folders.push(folder);
  copyFileSync(join(service, "wrangler.jsonc"), join(folder, "wrangler.jsonc"));
  if (update) {
    const config = experimental_readRawConfig({
      config: join(folder, "wrangler.jsonc")
    }).rawConfig;
    update(config);
    writeFileSync(join(folder, "wrangler.jsonc"), JSON.stringify(config));
  }
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
    prepareDeployment(folder);
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
      source.previews!.d1_databases!.map((db) => [db.binding, db.database_id])
    );
    expect(
      read(folder, "wrangler.preview-migrations.json").d1_databases
    ).toEqual(artifact.previews.d1_databases);
    expect(artifact.previews.kv_namespaces).toEqual(
      source.previews!.kv_namespaces
    );
    expect(artifact.previews.r2_buckets).toEqual(source.previews!.r2_buckets);
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
    // Rebuilding after a binding change must replace the previous migration target.
    source.previews!.d1_databases![0].database_id =
      "11111111-1111-4111-8111-111111111111";
    writeFileSync(join(folder, "wrangler.jsonc"), JSON.stringify(source));
    prepareDeployment(folder);
    expect(
      read(folder, "wrangler.preview-migrations.json").d1_databases[0]
        .database_id
    ).toBe(source.previews!.d1_databases![0].database_id);
  });

  it("rejects production resources and duplicated staging IDs before writing an artifact", () => {
    const overrides: ((config: Unstable_RawConfig) => void)[] = [
      (config) => {
        config.previews!.d1_databases![0].database_id =
          config.d1_databases![0].database_id;
      },
      (config) => {
        config.previews!.d1_databases![0].database_id =
          config.d1_databases![0].database_id!.toUpperCase();
      },
      (config) => {
        config.previews!.d1_databases![0].database_id =
          config.previews!.d1_databases![1].database_id;
      },
      (config) => {
        config.previews!.kv_namespaces![0].id = config.kv_namespaces![0].id;
      },
      (config) => {
        config.previews!.kv_namespaces![1].id = config.kv_namespaces![1].id;
      },
      (config) => {
        config.previews!.r2_buckets![0].bucket_name =
          config.r2_buckets![0].bucket_name;
      },
      (config) => {
        config.previews!.kv_namespaces![0].id =
          config.previews!.kv_namespaces![1].id;
      }
    ];
    for (const override of overrides) {
      const folder = fixture(override);
      expect(() => prepareDeployment(folder)).toThrow(
        "Preview resources must use distinct non-production resources"
      );
      expect(existsSync(join(folder, "dist/wrangler.json"))).toBe(false);
      expect(
        existsSync(join(folder, "dist/wrangler.preview-migrations.json"))
      ).toBe(false);
    }
  });

  it("rejects missing, malformed, duplicated and unknown Preview bindings", () => {
    const overrides: ((config: Unstable_RawConfig) => void)[] = [
      (config) => {
        delete config.previews;
      },
      (config) => {
        delete config.previews!.kv_namespaces;
      },
      (config) => {
        config.previews!.d1_databases!.pop();
      },
      (config) => {
        config.previews!.kv_namespaces = [];
      },
      (config) => {
        config.previews!.r2_buckets = [];
      },
      (config) => {
        config.previews!.d1_databases![0].database_id = "invalid";
      },
      (config) => {
        config.previews!.kv_namespaces![0].id = "invalid";
      },
      (config) => {
        config.previews!.r2_buckets![0].bucket_name = "";
      },
      (config) => {
        config.previews!.d1_databases!.push({
          ...config.previews!.d1_databases![0]
        });
      },
      (config) => {
        config.previews!.d1_databases!.push({
          binding: "UNKNOWN",
          database_id: "11111111-1111-4111-8111-111111111111"
        });
      },
      (config) => {
        config.previews!.kv_namespaces!.push({
          binding: "UNKNOWN",
          id: "a".repeat(32)
        });
      },
      (config) => {
        config.previews!.r2_buckets!.push({
          binding: "UNKNOWN",
          bucket_name: "extra-preview-bucket"
        });
      },
      (config) => {
        config.previews!.d1_databases![0].binding = "UNKNOWN";
      },
      (config) => {
        config.previews!.kv_namespaces![0].binding = "UNKNOWN";
      },
      (config) => {
        config.previews!.r2_buckets![0].binding = "UNKNOWN";
      }
    ];
    for (const override of overrides) {
      const folder = fixture(override);
      expect(() => prepareDeployment(folder)).toThrow();
      expect(existsSync(join(folder, "dist"))).toBe(false);
    }
  });
});
