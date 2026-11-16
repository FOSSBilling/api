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
  d1_databases: z.array(
    z.looseObject({
      binding: z.string(),
      database_id: z.uuid().toLowerCase()
    })
  ),
  kv_namespaces: z.array(
    z.looseObject({
      binding: z.string(),
      id: z.string().regex(/^[a-f0-9]{32}$/)
    })
  ),
  r2_buckets: z.array(
    z.looseObject({
      binding: z.string(),
      bucket_name: z.string().min(1)
    })
  )
});

// Keep the bundle, runtime bindings and migration targets in one deployable artifact.
export function prepareDeployment(root: string) {
  const config: Unstable_RawConfig = experimental_readRawConfig({
    config: join(root, "wrangler.jsonc")
  }).rawConfig;
  const output = join(root, "dist");
  const resources = PreviewResourcesSchema.parse(config.previews);
  const production = new Set([
    ...(config.d1_databases ?? []).map((value) =>
      value.database_id?.toLowerCase()
    ),
    ...(config.kv_namespaces ?? []).map((value) => value.id),
    ...(config.r2_buckets ?? []).map((value) => value.bucket_name)
  ]);
  const groups = [
    {
      preview: resources.d1_databases,
      production: config.d1_databases ?? [],
      ids: resources.d1_databases.map((value) => value.database_id)
    },
    {
      preview: resources.kv_namespaces,
      production: config.kv_namespaces ?? [],
      ids: resources.kv_namespaces.map((value) => value.id)
    },
    {
      preview: resources.r2_buckets,
      production: config.r2_buckets ?? [],
      ids: resources.r2_buckets.map((value) => value.bucket_name)
    }
  ];
  for (const group of groups) {
    const bindings = group.preview.map((value) => value.binding);
    if (
      bindings.length !== group.production.length ||
      new Set(bindings).size !== bindings.length ||
      group.production.some((value) => !bindings.includes(value.binding))
    )
      throw new Error(
        "Preview resources must configure each production binding exactly once"
      );
    if (
      group.ids.some((value) => production.has(value)) ||
      new Set(group.ids).size !== group.ids.length
    )
      throw new Error(
        "Preview resources must use distinct non-production resources"
      );
  }
  mkdirSync(output, { recursive: true });
  rmSync(join(output, "migrations"), { recursive: true, force: true });
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
  const stagingDatabases = resources.d1_databases.map((database) => {
    const source = config.d1_databases?.find(
      (value) => value.binding === database.binding
    );
    if (!source)
      throw new Error(
        `No migration source configured for Preview database ${database.binding}`
      );
    return { ...database, migrations_dir: source.migrations_dir };
  });
  config.previews = {
    ...config.previews,
    ...resources,
    d1_databases: stagingDatabases
  };
  writeFileSync(
    join(output, "wrangler.preview-migrations.json"),
    JSON.stringify({ d1_databases: stagingDatabases }, null, 2) + "\n"
  );
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
  prepareDeployment(process.cwd());
  console.log("Prepared API deployment configuration and migrations.");
}
