import { describe, it, expect, beforeEach } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../../../src/app";
import { mockD1Database } from "../../../utils/d1-mock";
import type { CentralAlertsResponse } from "../../../utils/test-types";

describe("Central Alerts API v1", () => {
  beforeEach(() => {
    // Mock the D1 database binding
    env.DB_CENTRAL_ALERTS = mockD1Database;
  });

  describe("GET /list", () => {
    it("should return list of central alerts", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: CentralAlertsResponse = await response.json();

      expect(data).toHaveProperty("result");
      expect(data).toHaveProperty("error", null);
      expect(data.result).toHaveProperty("alerts");
      expect(Array.isArray(data.result.alerts)).toBe(true);
    });

    it("should return alerts from static data", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      const data: CentralAlertsResponse = await response.json();
      const alerts = data.result.alerts;

      const sqlAlert = alerts.find((alert: { id: string }) => alert.id === "1");
      expect(sqlAlert).toBeTruthy();
      expect(sqlAlert!.type).toBe("danger");
      expect(sqlAlert!.message).toContain("SQL injection");
      expect(sqlAlert!.max_fossbilling_version).toBe("0.5.2");
    });

    it("should include buttons in alerts when present", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      const data: CentralAlertsResponse = await response.json();
      const alerts = data.result.alerts;

      const sqlAlert = alerts.find((alert: { id: string }) => alert.id === "1");
      expect(sqlAlert!.buttons).toBeTruthy();
      expect(Array.isArray(sqlAlert!.buttons)).toBe(true);
      expect(sqlAlert!.buttons!.length).toBeGreaterThan(0);

      sqlAlert!.buttons!.forEach((button: { text: string; link: string }) => {
        expect(button).toHaveProperty("text");
        expect(button).toHaveProperty("link");
        expect(button.link).toMatch(/^https?:\/\//);
      });
    });

    it("should redirect trailing slash to non-trailing slash path", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list/",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(301);
      const location = response.headers.get("Location");
      expect(location).toContain("/central-alerts/v1/list");
      expect(location).not.toContain("/central-alerts/v1/list/");
    });

    it("should return consistent data on multiple requests", async () => {
      const ctx1 = createExecutionContext();
      const response1 = await app.request(
        "/central-alerts/v1/list",
        {},
        env,
        ctx1
      );
      await waitOnExecutionContext(ctx1);
      const data1 = await response1.json();

      const ctx2 = createExecutionContext();
      const response2 = await app.request(
        "/central-alerts/v1/list",
        {},
        env,
        ctx2
      );
      await waitOnExecutionContext(ctx2);
      const data2 = await response2.json();

      expect(data1).toEqual(data2);
    });

    it("should return valid ISO 8601 datetime", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      const data: CentralAlertsResponse = await response.json();
      const alerts = data.result.alerts;

      alerts.forEach((alert: { datetime: string }) => {
        const date = new Date(alert.datetime);
        expect(date.toString()).not.toBe("Invalid Date");
        expect(alert.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      });
    });
  });

  describe("Error Cases", () => {
    it("should not expose database exception details", async () => {
      env.DB_CENTRAL_ALERTS = {
        prepare() {
          throw new Error("secret schema detail");
        }
      } as unknown as D1Database;

      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(500);
      const data = (await response.json()) as {
        error: { message: string; code: string };
      };
      expect(data.error.message).toBe("Unable to load central alerts");
      expect(data.error.message).not.toContain("secret schema detail");
    });

    it("should return 404 for unknown routes", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/unknown",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
    });

    it("should redirect root path with trailing slash", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/central-alerts/v1/", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(301);
      const location = response.headers.get("Location");
      expect(location).toContain("/central-alerts/v1");
      expect(location).not.toContain("/central-alerts/v1/");
    });
  });
});
