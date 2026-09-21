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
      expect(data?.alerts).toHaveLength(1);
      expect(data?.alerts[0].id).toBe("1");
      expect(data?.alerts[0].title).toBe("Test Alert");
      expect(data?.alerts[0].buttons).toHaveLength(1);
      expect(data?.alerts[0].buttons?.[0].text).toBe("Test Button");
      expect(data?.hasMore).toBe(false);
    });

    it("should honor an opt-in pagination window", async () => {
      // A second, newer alert so a limit-1 page actually has a boundary
      // to probe: hasMore must come from the limit+1 row, not the count.
      const drizzleDb = getCentralAlertsDb(env.DB_CENTRAL_ALERTS);
      await drizzleDb.insert(centralAlerts).values({
        id: "2",
        title: "Second Alert",
        message: "Newer alert",
        type: "info",
        dismissible: false,
        minFossbillingVersion: "0.0.0",
        maxFossbillingVersion: "1.0.0",
        includePreviewBranch: false,
        buttons: null,
        datetime: "2024-01-01T00:00:00Z"
      });

      const firstPage = await db.getAllAlerts({ limit: 1, offset: 0 });
      expect(firstPage.error).toBeNull();
      expect(firstPage.data?.alerts.map((alert) => alert.id)).toEqual(["2"]);
      expect(firstPage.data?.hasMore).toBe(true);

      const secondPage = await db.getAllAlerts({ limit: 1, offset: 1 });
      expect(secondPage.error).toBeNull();
      expect(secondPage.data?.alerts.map((alert) => alert.id)).toEqual(["1"]);
      expect(secondPage.data?.hasMore).toBe(false);
    });
  });
});
