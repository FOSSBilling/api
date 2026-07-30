import { desc } from "drizzle-orm";
import { CentralAlert } from "./interfaces";
import { DatabaseResult } from "../../../lib/interfaces";
import { CentralAlertsDb } from "../../../lib/db";
import { centralAlerts } from "./db/schema";

export class CentralAlertsDatabase {
  constructor(private db: CentralAlertsDb) {}

  async getAllAlerts(): Promise<DatabaseResult<CentralAlert[]>> {
    let rows;
    try {
      rows = await this.db
        .select()
        .from(centralAlerts)
        .orderBy(desc(centralAlerts.datetime));
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "DATABASE_ERROR"
        }
      };
    }

    const alerts: CentralAlert[] = rows.map((row) => ({
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

    return { data: alerts, error: null };
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
