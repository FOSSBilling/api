import { defineConfig } from "drizzle-kit";

// See drizzle.extensions.config.ts for why `out` matches wrangler's
// migrations_dir instead of using drizzle-kit's own D1 driver to apply.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/services/central-alerts/v1/db/schema.ts",
  out: "./src/services/central-alerts/v1/db/migrations"
});
