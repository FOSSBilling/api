import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, check } from "drizzle-orm/sqlite-core";

// Bootstrapped historically via db/init.sql + scripts/init-db.ts
// (`wrangler d1 execute --file`), not wrangler's migrations mechanism.
// This schema is the baseline for adopting drizzle-kit-managed migrations
// for DB_CENTRAL_ALERTS - see db/migrations/0001_create_central_alerts.sql.
//
// dismissible/include_preview_branch were declared BOOLEAN in the original
// DDL (SQLite has no native boolean type - BOOLEAN gets NUMERIC affinity,
// same underlying storage as INTEGER). Modeled here as
// integer(..., { mode: "boolean" }) for real type safety; the generated
// migration's declared type name will read "integer" rather than
// "boolean" - a cosmetic, affinity-equivalent difference confirmed safe
// during baseline verification.
export const centralAlerts = sqliteTable(
  "central_alerts",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    type: text("type").notNull(),
    dismissible: integer("dismissible", { mode: "boolean" })
      .notNull()
      .default(false),
    minFossbillingVersion: text("min_fossbilling_version").notNull(),
    maxFossbillingVersion: text("max_fossbilling_version").notNull(),
    includePreviewBranch: integer("include_preview_branch", {
      mode: "boolean"
    })
      .notNull()
      .default(false),
    buttons: text("buttons").default("[]"),
    datetime: text("datetime").notNull(),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    index("idx_central_alerts_type").on(table.type),
    index("idx_central_alerts_version_range").on(
      table.minFossbillingVersion,
      table.maxFossbillingVersion
    ),
    index("idx_central_alerts_datetime").on(table.datetime),
    check(
      "central_alerts_type_check",
      sql`${table.type} IN ('success', 'info', 'warning', 'danger')`
    )
  ]
);
