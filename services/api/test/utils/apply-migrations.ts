import { applyD1Migrations, env } from "cloudflare:test";

// Call from a test file's own beforeAll (not vitest.config.ts's
// setupFiles - see the comment in vitest.config.ts for why). applyD1Migrations
// records applied migrations in a bookkeeping table, so calling this
// redundantly across multiple beforeAll hooks in the same test file is
// harmless.
let applied = false;

export async function applyTestMigrations(): Promise<void> {
  if (applied) return;
  applied = true;

  await applyD1Migrations(env.DB_EXTENSIONS, env.TEST_MIGRATIONS_EXTENSIONS);
  await applyD1Migrations(
    env.DB_CENTRAL_ALERTS,
    env.TEST_MIGRATIONS_CENTRAL_ALERTS
  );
}
