import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../../../src/app";
import type { CentralAlertsResponse } from "../../../utils/test-types";
import { applyTestMigrations } from "../../../utils/apply-migrations";

let requestHost: string;

// No fixture-insertion setup needed beyond migrations: migrations already
// seed exactly the row these tests assert on (see
// src/services/central-alerts/v1/db/migrations/0001_seed_initial_alert.sql)
// against the real local D1.
describe("Central Alerts API v1", () => {
  beforeAll(applyTestMigrations);
  beforeEach(() => {
    // Isolate edge entries without relying on a client-controlled bypass.
    requestHost = `${crypto.randomUUID()}.example.com`;
  });

  describe("GET /list", () => {
    it("should return list of central alerts", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        `https://${requestHost}/central-alerts/v1/list`,
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

    // The second identical request must avoid D1.
    it("should serve a repeated request from the edge cache", async () => {
      const requestOnce = async () => {
        const ctx = createExecutionContext();
        const response = await app.request(
          `https://${requestHost}/central-alerts/v1/list`,
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

    it.each([
      {
        initial: "",
        variants: [
          "?nonce=one",
          "?nonce=two",
          "?limit=bad",
          "?limit=0",
          "?limit=101",
          "?limit=",
          "?limit=bad&limit=1"
        ]
      },
      {
        initial: "?limit=1",
        variants: [
          "?nonce=one&offset=0&limit=01",
          "?limit=1e0&offset=bad",
          "?limit=0x1&offset=-1",
          "?limit=%201%20&offset=0.0",
          "?%6cimit=1",
          "?%6cimit=2&limit=1",
          "?limit=1&limit=2"
        ]
      },
      {
        initial: "?limit=2&offset=1",
        variants: ["?offset=01&nonce=one&limit=2.0", "?limit=2&offset=1e0"]
      }
    ])(
      "should reuse the effective page for $initial",
      async ({ initial, variants }) => {
        const requestList = async (query: string, authorization?: string) => {
          const ctx = createExecutionContext();
          const response = await app.request(
            `https://${requestHost}/central-alerts/v1/list${query}`,
            { headers: authorization === undefined ? {} : { authorization } },
            env,
            ctx
          );
          await waitOnExecutionContext(ctx);
          return response;
        };
        const first = await requestList(initial);
        expect(first.status).toBe(200);
        const body = await first.text();
        const realDb = env.DB_CENTRAL_ALERTS;
        env.DB_CENTRAL_ALERTS = {
          prepare() {
            throw new Error("unexpected D1 read");
          }
        } as unknown as D1Database;
        try {
          for (const query of variants) {
            for (const authorization of [undefined, "x", "Bearer arbitrary"]) {
              const response = await requestList(query, authorization);
              expect(response.status).toBe(200);
              await expect(response.text()).resolves.toBe(body);
              expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
                "*"
              );
            }
          }
          // Validation must run before lookup, even when the full list is warm.
          const invalid = await requestList("?offset=0&limit=bad", "x");
          expect(invalid.status).toBe(422);
          expect(invalid.headers.get("cache-control")).toBeNull();
        } finally {
          env.DB_CENTRAL_ALERTS = realDb;
        }
      }
    );

    it("should share cached responses across encoded route aliases", async () => {
      const requestPath = async (path: string) => {
        const ctx = createExecutionContext();
        const response = await app.request(
          `https://${requestHost}${path}`,
          {},
          env,
          ctx
        );
        await waitOnExecutionContext(ctx);
        return response;
      };
      const first = await requestPath("/central-alerts/v1/list");
      expect(first.status).toBe(200);
      const body = await first.text();
      const realDb = env.DB_CENTRAL_ALERTS;
      env.DB_CENTRAL_ALERTS = {
        prepare() {
          throw new Error("unexpected D1 read");
        }
      } as unknown as D1Database;
      try {
        for (const path of [
          "/central-alerts/v1/%6cist",
          "/central-alerts/v1/%6Cist",
          "/%63entral-alerts/v1/list?nonce=one",
          "/central-alerts/%761/list"
        ]) {
          const response = await requestPath(path);
          expect(response.status).toBe(200);
          await expect(response.text()).resolves.toBe(body);
        }
      } finally {
        env.DB_CENTRAL_ALERTS = realDb;
      }
    });

    it("should keep the full list and different pagination windows distinct", async () => {
      const bodies = [];
      for (const query of ["", "?limit=1", "?limit=2", "?limit=1&offset=1"]) {
        const ctx = createExecutionContext();
        const response = await app.request(
          `https://${requestHost}/central-alerts/v1/list${query}`,
          {},
          env,
          ctx
        );
        await waitOnExecutionContext(ctx);
        expect(response.status).toBe(200);
        bodies.push(
          (await response.json()) as {
            result: {
              alerts: unknown[];
              pagination?: { limit: number; offset: number };
            };
          }
        );
      }
      expect(bodies[0].result).not.toHaveProperty("pagination");
      expect(bodies[1].result.pagination).toMatchObject({
        limit: 1,
        offset: 0
      });
      expect(bodies[2].result.pagination).toMatchObject({
        limit: 2,
        offset: 0
      });
      expect(bodies[3].result.pagination).toMatchObject({
        limit: 1,
        offset: 1
      });
      expect(bodies[1].result.alerts).toHaveLength(1);
      expect(bodies[3].result.alerts).toHaveLength(0);
    });

    // offset is only meaningful alongside a limit: a stray offset alone
    // must not silently fall through to the full legacy response the way
    // it would if the param were simply ignored.
    it("should reject offset without limit with 422", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        `https://${requestHost}/central-alerts/v1/list?offset=1`,
        {},
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
        `https://${requestHost}/central-alerts/v1/list`,
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
        `https://${requestHost}/central-alerts/v1/list`,
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
        `https://${requestHost}/central-alerts/v1/list/`,
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
        `https://${requestHost}/central-alerts/v1/list`,
        {},
        env,
        ctx1
      );
      await waitOnExecutionContext(ctx1);
      const data1 = await response1.json();

      const ctx2 = createExecutionContext();
      const response2 = await app.request(
        `https://${requestHost}/central-alerts/v1/list`,
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
        `https://${requestHost}/central-alerts/v1/list`,
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
    it("should not expose or cache database errors", async () => {
      const realDb = env.DB_CENTRAL_ALERTS;
      env.DB_CENTRAL_ALERTS = {
        prepare() {
          throw new Error("secret schema detail");
        }
      } as unknown as D1Database;
      const requestList = async () => {
        const ctx = createExecutionContext();
        const response = await app.request(
          `https://${requestHost}/central-alerts/v1/list`,
          {},
          env,
          ctx
        );
        await waitOnExecutionContext(ctx);
        return response;
      };
      try {
        const response = await requestList();
        expect(response.status).toBe(500);
        expect(response.headers.get("cache-control")).toBeNull();
        const data = (await response.json()) as {
          error: { message: string; code: string };
        };
        expect(data.error.message).toBe("Unable to load central alerts");
        expect(data.error.message).not.toContain("secret schema detail");
      } finally {
        env.DB_CENTRAL_ALERTS = realDb;
      }
      expect((await requestList()).status).toBe(200);
    });

    it("should return 404 for unknown routes", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        `https://${requestHost}/central-alerts/v1/unknown`,
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
    });

    it("should redirect root path with trailing slash", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        `https://${requestHost}/central-alerts/v1/`,
        {},
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
