import { desc, sql } from "drizzle-orm";
import { CentralAlert } from "./interfaces";
import { DatabaseResult } from "../../../lib/interfaces";
import { CentralAlertsDb } from "../../../lib/db";
import { centralAlerts } from "./db/schema";

export class CentralAlertsDatabase {
  constructor(private db: CentralAlertsDb) {}

  // page (when given) bounds the query with a limit+1 probe - the extra
  // row only answers has_more and is trimmed off. Omitted => every alert,
  // unchanged from the original contract.
  async getAllAlerts(page?: {
    limit: number;
    offset: number;
  }): Promise<DatabaseResult<{ alerts: CentralAlert[]; hasMore: boolean }>> {
    let rows;
    try {
      // Offset pagination needs a deterministic total order; rowid breaks
      // datetime ties the same way listHistory does (paged path only - the
      // unpaginated default keeps its original single-key ordering).
      const base = this.db
        .select()
        .from(centralAlerts)
        .orderBy(desc(centralAlerts.datetime), sql`rowid DESC`);
      rows = page
        ? await base.offset(page.offset).limit(page.limit + 1)
        : await base;
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "DATABASE_ERROR"
        }
      };
    }

    const hasMore = page ? rows.length > page.limit : false;
    const trimmed = page && hasMore ? rows.slice(0, page.limit) : rows;

    const alerts: CentralAlert[] = trimmed.map((row) => ({
      id: row.id,
      title: row.title,
      message: row.message,
      type: row.type as CentralAlert["type"],
      dismissible: row.dismissible,
      min_fossbilling_version: row.minFossbillingVersion,
      max_fossbilling_version: row.maxFossbillingVersion,
      include_preview_branch: row.includePreviewBranch,
      buttons: parseButtons(row.buttons),
      datetime: row.datetime
    }));

    return { data: { alerts, hasMore }, error: null };
  }
}

function parseButtons(value: string | null): CentralAlert["buttons"] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}
