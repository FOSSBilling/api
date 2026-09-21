import { describe, it, expect, beforeAll } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../../../src/app";
import type { CentralAlertsResponse } from "../../../utils/test-types";
import { applyTestMigrations } from "../../../utils/apply-migrations";

// Authorization header makes hono's cache middleware skip (same pattern as
// the stats tests) so each request reaches the handler; the cache path is
// covered by the dedicated cache test below, which omits the header.
const BYPASS_CACHE = { authorization: "test-bypass-cache" } as const;

// No fixture-insertion setup needed beyond migrations: migrations already
// seed exactly the row these tests assert on (see
// src/services/central-alerts/v1/db/migrations/0001_seed_initial_alert.sql)
// against the real local D1.
describe("Central Alerts API v1", () => {
  beforeAll(applyTestMigrations);

  describe("GET /list", () => {
    it("should return list of central alerts", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list",
        { headers: BYPASS_CACHE },
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

    // Deliberately omits BYPASS_CACHE so hono's cache middleware
    // participates: the second identical request is served from the edge
    // cache without reaching D1.
    it("should serve a repeated request from the edge cache", async () => {
      const requestOnce = async () => {
        const ctx = createExecutionContext();
        const response = await app.request(
          "/central-alerts/v1/list",
          {},
          env,
          ctx
        );
        await waitOnExecutionContext(ctx);
        return response;
      };

      const first = await requestOnce();
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toContain("max-age=60");
      const firstBody = await first.text();

      // Break D1 so a second request that reaches the handler fails loudly:
      // body equality alone can't tell a cache hit from a deterministic
      // handler re-run (same pattern as the error-case test below).
      const realDb = env.DB_CENTRAL_ALERTS;
      env.DB_CENTRAL_ALERTS = {
        prepare() {
          throw new Error("secret schema detail");
        }
      } as unknown as D1Database;
      try {
        const second = await requestOnce();
        expect(second.status).toBe(200);
        await expect(second.text()).resolves.toBe(firstBody);
      } finally {
        env.DB_CENTRAL_ALERTS = realDb;
      }
    });

    // offset is only meaningful alongside a limit: a stray offset alone
    // must not silently fall through to the full legacy response the way
    // it would if the param were simply ignored.
    it("should reject offset without limit with 422", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list?offset=1",
        { headers: BYPASS_CACHE },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(422);
      const data = (await response.json()) as {
        result: null;
        error: { message: string; code: string };
      };
      expect(data.result).toBeNull();
      expect(data.error.message).toBe("offset requires limit");
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("should return alerts from static data", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list",
        { headers: BYPASS_CACHE },
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
        { headers: BYPASS_CACHE },
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
        { headers: BYPASS_CACHE },
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
        { headers: BYPASS_CACHE },
        env,
        ctx1
      );
      await waitOnExecutionContext(ctx1);
      const data1 = await response1.json();

      const ctx2 = createExecutionContext();
      const response2 = await app.request(
        "/central-alerts/v1/list",
        { headers: BYPASS_CACHE },
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
        { headers: BYPASS_CACHE },
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
        { headers: BYPASS_CACHE },
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
        { headers: BYPASS_CACHE },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
    });

    it("should redirect root path with trailing slash", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/",
        { headers: BYPASS_CACHE },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(301);
      const location = response.headers.get("Location");
      expect(location).toContain("/central-alerts/v1");
      expect(location).not.toContain("/central-alerts/v1/");
    });
  });
});
