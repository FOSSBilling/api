import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";
import { z } from "zod";

const PreviewResourcesSchema = z.object({
  DB_EXTENSIONS: z.uuid().toLowerCase(),
  DB_CENTRAL_ALERTS: z.uuid().toLowerCase(),
  AUTH_KV: z.string().regex(/^[a-f0-9]{32}$/),
  CACHE_KV: z.string().regex(/^[a-f0-9]{32}$/),
  DOWNLOAD_BUCKET: z.string().min(1)
});

// Keep the bundle, runtime bindings and migration targets in one deployable artifact.
export function prepareDeployment(root: string, previewResources?: string) {
  const config: Unstable_RawConfig = experimental_readRawConfig({
    config: join(root, "wrangler.jsonc")
  }).rawConfig;
  const output = join(root, "dist");
  const resources = previewResources
    ? PreviewResourcesSchema.parse(JSON.parse(previewResources))
    : undefined;
  if (resources) {
    const production = new Set([
      ...(config.d1_databases ?? []).map((value) => value.database_id),
      ...(config.kv_namespaces ?? []).map((value) => value.id),
      ...(config.r2_buckets ?? []).map((value) => value.bucket_name)
    ]);
    const values = Object.values(resources);
    if (
      values.some((value) => production.has(value)) ||
      resources.DB_EXTENSIONS === resources.DB_CENTRAL_ALERTS ||
      resources.AUTH_KV === resources.CACHE_KV
    )
      throw new Error(
        "API_PREVIEW_RESOURCES must use distinct non-production resources"
      );
  }
  mkdirSync(output, { recursive: true });
  rmSync(join(output, "migrations"), { recursive: true, force: true });
  rmSync(join(output, "wrangler.preview-migrations.json"), { force: true });
  config.d1_databases = (config.d1_databases ?? []).map((database) => {
    if (!database.migrations_dir)
      throw new Error(`Missing migrations_dir for ${database.binding}`);
    const migrations = `migrations/${database.binding}`;
    mkdirSync(join(output, migrations), { recursive: true });
    for (const filename of readdirSync(
      join(root, database.migrations_dir)
    ).filter((value) => value.endsWith(".sql")))
      copyFileSync(
        join(root, database.migrations_dir, filename),
        join(output, migrations, filename)
      );
    return { ...database, migrations_dir: migrations };
  });
  if (resources) {
    const databaseIds: Record<string, string> = {
      DB_EXTENSIONS: resources.DB_EXTENSIONS,
      DB_CENTRAL_ALERTS: resources.DB_CENTRAL_ALERTS
    };
    const stagingDatabases = (config.d1_databases ?? []).map((database) => {
      const id = databaseIds[database.binding];
      if (!id)
        throw new Error(
          `No Preview database configured for ${database.binding}`
        );
      return { ...database, database_id: id, database_name: undefined };
    });
    config.previews = {
      ...config.previews,
      d1_databases: stagingDatabases,
      kv_namespaces: [
        { binding: "AUTH_KV", id: resources.AUTH_KV },
        { binding: "CACHE_KV", id: resources.CACHE_KV }
      ],
      r2_buckets: [
        { binding: "DOWNLOAD_BUCKET", bucket_name: resources.DOWNLOAD_BUCKET }
      ],
      services: []
    };
    writeFileSync(
      join(output, "wrangler.preview-migrations.json"),
      JSON.stringify({ d1_databases: stagingDatabases }, null, 2) + "\n"
    );
  }
  Reflect.deleteProperty(config, "$schema");
  config.main = "index.js";
  config.no_bundle = true;
  writeFileSync(
    join(output, "wrangler.json"),
    JSON.stringify(config, null, 2) + "\n"
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  prepareDeployment(process.cwd(), process.env.API_PREVIEW_RESOURCES);
  console.log("Prepared API deployment configuration and migrations.");
}
