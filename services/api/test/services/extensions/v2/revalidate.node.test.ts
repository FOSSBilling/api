import { expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryCache } from "../../../../src/lib/adapters/node/cache";
import { platformMiddleware } from "../../../../src/lib/middleware";
import { listCacheKey } from "../../../../src/services/extensions/v1/list-cache";
import { revalidateExtensions } from "../../../../src/services/extensions/v2/revalidate";

it("revalidates through the platform capabilities without a Cloudflare context", async () => {
  const cache = createMemoryCache();
  const tasks: Promise<unknown>[] = [];
  const requests: Request[] = [];
  const app = new Hono();
  app.use(
    "*",
    platformMiddleware(
      {
        caches: { CACHE_KV: cache },
        environment: {
          get: (name) =>
            name === "EXTENSIONS_REVALIDATE_SECRET" ? "local-secret" : undefined
        },
        services: {
          EXTENSIONS_FRONTEND: async (request) => {
            requests.push(request);
            return new Response(null, { status: 204 });
          }
        }
      },
      (task) => tasks.push(task)
    )
  );
  app.post("/revalidate", (c) => {
    revalidateExtensions(c);
    return c.body(null, 204);
  });

  try {
    const key = listCacheKey("module", undefined);
    await cache.put(key, "cached extension list");
    await cache.put("unrelated", "keep");
    expect((await app.request("/revalidate", { method: "POST" })).status).toBe(
      204
    );
    expect(tasks.length).toBeGreaterThan(0);
    await Promise.all(tasks);
    expect(await cache.get(key)).toBeNull();
    expect(await cache.get("unrelated")).toBe("keep");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBeInstanceOf(Request);
  } finally {
    cache.close();
  }
});
