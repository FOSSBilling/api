import { describe, it, expect, beforeEach } from "vitest";
import { Hono, Context } from "hono";
import { platformMiddleware, getPlatform } from "../../src/lib/middleware";
import { createPlatformContext } from "../../src/lib/context";
import { IPlatformBindings } from "../../src/lib/interfaces";

describe("Middleware", () => {
  let app: Hono;
  let mockBindings: IPlatformBindings;

  beforeEach(() => {
    app = new Hono();

    mockBindings = {
      caches: {
        testCache: {
          get: async () => null,
          put: async () => {},
          delete: async () => {}
        }
      },
      environment: {
        get: () => undefined,
        has: () => false
      }
    };
  });

  describe("platformMiddleware", () => {
    it("should set platform context on request", async () => {
      app.use("*", platformMiddleware(mockBindings));

      app.get("/test", (c) => {
        const platform = c.get("platform");
        return c.json({ hasPlatform: !!platform });
      });

      const response = await app.request("/test");
      const data = (await response.json()) as { hasPlatform: boolean };

      expect(data.hasPlatform).toBe(true);
    });

    it("should allow access to cache through platform context", async () => {
      app.use("*", platformMiddleware(mockBindings));

      app.get("/test", (c) => {
        const platform = c.get("platform");
        const cache = platform.getCache("testCache");
        return c.json({ hasCache: !!cache });
      });

      const response = await app.request("/test");
      const data = (await response.json()) as { hasCache: boolean };

      expect(data.hasCache).toBe(true);
    });

    it("should allow access to environment through platform context", async () => {
      const envWithValues = {
        get: (key: string) => (key === "TEST_VAR" ? "test-value" : undefined),
        has: () => false
      };

      app.use(
        "*",
        platformMiddleware({ ...mockBindings, environment: envWithValues })
      );

      app.get("/test", (c) => {
        const platform = c.get("platform");
        const env = platform.getEnv("TEST_VAR");
        return c.json({ envValue: env });
      });

      const response = await app.request("/test");
      const data = (await response.json()) as { envValue?: string };

      expect(data.envValue).toBe("test-value");
    });

    it("should allow access to raw Hono context", async () => {
      app.use("*", platformMiddleware(mockBindings));

      app.get("/test", (c) => {
        const platform = c.get("platform");
        return c.json({ hasRawContext: !!platform.raw });
      });

      const response = await app.request("/test");
      const data = (await response.json()) as { hasRawContext: boolean };

      expect(data.hasRawContext).toBe(true);
    });

    it("should pass control to next middleware", async () => {
      let middlewareExecuted = false;
      let routeExecuted = false;

      app.use("*", platformMiddleware(mockBindings), async (_c, next) => {
        middlewareExecuted = true;
        await next();
      });

      app.get("/test", (c) => {
        routeExecuted = true;
        return c.json({ success: true });
      });

      await app.request("/test");

      expect(middlewareExecuted).toBe(true);
      expect(routeExecuted).toBe(true);
    });
  });

  describe("getPlatform", () => {
    it("should retrieve platform context from Hono context", async () => {
      const mockHonoContext = {
        get: (key: string) => {
          if (key === "platform") {
            return createPlatformContext(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              {} as Context<any, any, {}>, // eslint-disable-line @typescript-eslint/no-empty-object-type
              mockBindings
            );
          }
          return undefined;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
      } as unknown as Context<any, any, {}>;

      const platform = getPlatform(mockHonoContext);

      expect(platform).toBeDefined();
      expect(platform.getCache("testCache")).toBeDefined();
    });

    it("should throw error when platform context not found", () => {
      const mockHonoContext = {
        get: () => undefined
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
      } as unknown as Context<any, any, {}>;

      expect(() => getPlatform(mockHonoContext)).toThrow(
        "Platform context not found"
      );
    });

    it("should throw error when platform context is null", () => {
      const mockHonoContext = {
        get: () => null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
      } as unknown as Context<any, any, {}>;

      expect(() => getPlatform(mockHonoContext)).toThrow(
        "Platform context not found"
      );
    });
  });

  describe("Integration with Hono", () => {
    it("should work with multiple middleware", async () => {
      let firstMiddleware = false;
      let secondMiddleware = false;

      app.use("*", async (_c, next) => {
        firstMiddleware = true;
        await next();
      });

      app.use("*", platformMiddleware(mockBindings), async (_c, next) => {
        secondMiddleware = true;
        await next();
      });

      app.get("/test", (c) => {
        const platform = c.get("platform");
        return c.json({ success: true, hasPlatform: !!platform });
      });

      const response = await app.request("/test");
      const data = (await response.json()) as {
        success: boolean;
        hasPlatform: boolean;
      };

      expect(firstMiddleware).toBe(true);
      expect(secondMiddleware).toBe(true);
      expect(data.success).toBe(true);
      expect(data.hasPlatform).toBe(true);
    });

    it("should persist platform context across routes", async () => {
      app.use("*", platformMiddleware(mockBindings));

      app.get("/test1", (c) => {
        const platform = c.get("platform");
        return c.json({ contextType: typeof platform.getEnv });
      });

      app.get("/test2", (c) => {
        const platform = c.get("platform");
        return c.json({ contextType: typeof platform.getCache });
      });

      const response1 = await app.request("/test1");
      const response2 = await app.request("/test2");

      const data1 = (await response1.json()) as { contextType: string };
      const data2 = (await response2.json()) as { contextType: string };

      expect(data1.contextType).toBe("function");
      expect(data2.contextType).toBe("function");
    });
  });
});
