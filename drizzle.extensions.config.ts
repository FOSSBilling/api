import { defineConfig } from "drizzle-kit";

// Schema source for the whole DB_EXTENSIONS database - shared by v1 (read
// only) and v2 (owns writes/migrations). Migrations are generated here but
// applied via `wrangler d1 migrations apply DB_EXTENSIONS` (see
// migrations_dir in wrangler.jsonc), not drizzle-kit's own D1 driver, so no
// Cloudflare credentials are needed just to generate a migration.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/services/extensions/v2/db/schema.ts",
  out: "./src/services/extensions/v2/db/migrations"
});
