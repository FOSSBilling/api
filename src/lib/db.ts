import { drizzle } from "drizzle-orm/d1";
import * as extensionsSchema from "../services/extensions/v2/db/schema";
import * as centralAlertsSchema from "../services/central-alerts/v1/db/schema";

export type ExtensionsDb = ReturnType<typeof drizzle<typeof extensionsSchema>>;
export type CentralAlertsDb = ReturnType<
  typeof drizzle<typeof centralAlertsSchema>
>;

// DB_EXTENSIONS is shared by v1 (read-only) and v2 (owns writes/migrations,
// see src/services/extensions/v2/db/schema.ts for the full table set).
export function getExtensionsDb(d1: D1Database): ExtensionsDb {
  return drizzle(d1, { schema: extensionsSchema });
}

export function getCentralAlertsDb(d1: D1Database): CentralAlertsDb {
  return drizzle(d1, { schema: centralAlertsSchema });
}
