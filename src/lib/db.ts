import { drizzle } from "drizzle-orm/d1";
import * as extensionsSchema from "../services/extensions/v2/db/schema";
import * as centralAlertsSchema from "../services/central-alerts/v1/db/schema";

export type ExtensionsDb = ReturnType<typeof drizzle<typeof extensionsSchema>>;
export type CentralAlertsDb = ReturnType<
  typeof drizzle<typeof centralAlertsSchema>
>;

// drizzle(d1, {schema}) runs extractTablesRelationalConfig over every table on
// each call - ~35us against the extensions schema, versus ~0.4us without the
// schema option. Routes and middleware each build their own handle, so a
// single request paid that two or three times over. The config only powers
// db.query.*, which this codebase never uses, but dropping the schema would
// change the exported types; caching per binding keeps them identical and
// builds the config once per isolate. The wrapper is stateless, so sharing one
// instance across requests is safe, and tests that swap in a wrapped D1 (see
// test/services/extensions/v2/db-interceptor.ts) get their own entry.
const extensionsDbs = new WeakMap<D1Database, ExtensionsDb>();
const centralAlertsDbs = new WeakMap<D1Database, CentralAlertsDb>();

// DB_EXTENSIONS is shared by v1 (read-only) and v2 (owns writes/migrations,
// see src/services/extensions/v2/db/schema.ts for the full table set).
export function getExtensionsDb(d1: D1Database): ExtensionsDb {
  const cached = extensionsDbs.get(d1);
  if (cached) return cached;
  const db = drizzle(d1, { schema: extensionsSchema });
  extensionsDbs.set(d1, db);
  return db;
}

export function getCentralAlertsDb(d1: D1Database): CentralAlertsDb {
  const cached = centralAlertsDbs.get(d1);
  if (cached) return cached;
  const db = drizzle(d1, { schema: centralAlertsSchema });
  centralAlertsDbs.set(d1, db);
  return db;
}
