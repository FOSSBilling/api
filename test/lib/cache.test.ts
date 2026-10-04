import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  normalizePublicCacheKey,
  publicResponseCache
} from "../../src/lib/cache";

describe("cache helpers", () => {
  it("normalizes public cache keys by removing query strings and fragments", () => {
    expect(
      normalizePublicCacheKey(
        "https://api.fossbilling.net/versions/v1/latest?cacheBust=1#section"
      )
    ).toBe("https://api.fossbilling.net/versions/v1/latest");
  });

  it("keeps different public paths isolated", () => {
    expect(
      normalizePublicCacheKey("https://api.fossbilling.net/versions/v1")
    ).not.toBe(
      normalizePublicCacheKey("https://api.fossbilling.net/versions/v1/count")
    );
  });
});

describe("public response cache", () => {
  it("preserves the original request for live handlers and error handling", async () => {
    const app = new Hono();
    const original = new Request("https://example.test/public", {
      headers: { Authorization: "x" }
    });
    // Asserted after fetch: an expect thrown inside the handler would be
    // routed to onError's 500, making the status assertion pass vacuously.
    const observed: { raw?: unknown; authorization?: string | null } = {};
    app.get(
      "/public",
      publicResponseCache({ cacheName: crypto.randomUUID(), wait: true }),
      (c) => {
        observed.raw = c.req.raw;
        observed.authorization = c.req.header("Authorization");
        throw new Error("handler failed");
      }
    );
    app.onError((_error, c) => {
      expect(c.req.raw).toBe(original);
      return c.text("failure", 500);
    });
    expect((await app.fetch(original)).status).toBe(500);
    expect(observed.raw).toBe(original);
    expect(observed.authorization).toBe("x");
  });

  it("restores the request when cache key generation fails", async () => {
    const app = new Hono();
    const original = new Request("https://example.test/public", {
      headers: { Authorization: "x" }
    });
    app.get(
      "/public",
      publicResponseCache({
        cacheName: crypto.randomUUID(),
        keyGenerator: () => {
          throw new Error("key failed");
        }
      }),
      (c) => c.text("unused")
    );
    app.onError((_error, c) => {
      expect(c.req.raw).toBe(original);
      return c.text("failure", 500);
    });
    expect((await app.fetch(original)).status).toBe(500);
  });

  it.each(["no-store", "private", "no-cache"])(
    "keeps %s responses out of the cache",
    async (control) => {
      const app = new Hono();
      let calls = 0;
      app.get(
        "/public",
        publicResponseCache({ cacheName: crypto.randomUUID(), wait: true }),
        (c) => {
          calls++;
          c.header("Cache-Control", control);
          return c.text("public");
        }
      );
      for (let i = 0; i < 2; i++) {
        await app.request("https://example.test/public", {
          headers: { Authorization: "x" }
        });
      }
      expect(calls).toBe(2);
    }
  );
});
