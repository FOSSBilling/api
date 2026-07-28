import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { CentralAlertsDatabase } from "../../../../src/services/central-alerts/v1/database";
import { getCentralAlertsDb } from "../../../../src/lib/db";
import { centralAlerts } from "../../../../src/services/central-alerts/v1/db/schema";
import { applyTestMigrations } from "../../../utils/apply-migrations";

describe("CentralAlertsDatabase", () => {
  let db: CentralAlertsDatabase;

  beforeAll(applyTestMigrations);

  beforeEach(async () => {
    const drizzleDb = getCentralAlertsDb(env.DB_CENTRAL_ALERTS);
    await drizzleDb.delete(centralAlerts);
    await drizzleDb.insert(centralAlerts).values({
      id: "1",
      title: "Test Alert",
      message: "This is a test alert",
      type: "info",
      dismissible: false,
      minFossbillingVersion: "0.0.0",
      maxFossbillingVersion: "1.0.0",
      includePreviewBranch: false,
      buttons:
        '[{"text":"Test Button","link":"https://example.com","type":"info"}]',
      datetime: "2023-01-01T00:00:00Z"
    });

    db = new CentralAlertsDatabase(drizzleDb);
  });

  describe("getAllAlerts", () => {
    it("should return all alerts with buttons", async () => {
      const { data, error } = await db.getAllAlerts();

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data?.[0].id).toBe("1");
      expect(data?.[0].title).toBe("Test Alert");
      expect(data?.[0].buttons).toHaveLength(1);
      expect(data?.[0].buttons?.[0].text).toBe("Test Button");
    });
  });
});
