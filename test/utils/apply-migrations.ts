import { applyD1Migrations, env } from "cloudflare:test";

// Call from a test file's own beforeAll (not vitest.config.ts's
// setupFiles - see the comment in vitest.config.ts for why). applyD1Migrations
// records applied migrations in a bookkeeping table, so calling this
// redundantly across multiple beforeAll hooks in the same test file is
// harmless.
let applied = false;

async function runStatements(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

export async function applyTestMigrations(): Promise<void> {
  if (applied) return;
  applied = true;

  // v1's schema.sql and the users stub must exist before the v2 migrations
  // list runs (see vitest.config.ts for why these are string bindings
  // rather than files read here).
  await runStatements(env.DB_EXTENSIONS, env.TEST_V1_SCHEMA_SQL);
  await runStatements(env.DB_EXTENSIONS, env.TEST_USERS_STUB_SQL);

  await applyD1Migrations(env.DB_EXTENSIONS, env.TEST_MIGRATIONS_EXTENSIONS);
  await applyD1Migrations(
    env.DB_CENTRAL_ALERTS,
    env.TEST_MIGRATIONS_CENTRAL_ALERTS
  );
}
