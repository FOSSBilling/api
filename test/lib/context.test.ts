import { describe, it, expect } from "vitest";
import { Context } from "hono";
import { createPlatformContext } from "../../src/lib/context";
import { IPlatformBindings } from "../../src/lib/interfaces";

// createPlatformContext is an object literal over the bindings; the only
// logic of its own is the missing-binding throw, so that is what is
// asserted here. The accessors are exercised end-to-end by every suite
// that boots the real app.
describe("createPlatformContext", () => {
  const mockBindings: IPlatformBindings = {
    caches: {
      testCache: {
        get: async () => null,
        put: async () => {},
        delete: async () => {}
      }
    },
    environment: {
      get: (key) => (key === "TEST_VAR" ? "test-value" : undefined)
    }
  };

  const mockHonoContext = {
    get: () => ({}),
    set: () => {},
    req: {},
    res: {}
  } as unknown as Context;

  it("exposes the binding accessors and the raw context", () => {
    const context = createPlatformContext(mockHonoContext, mockBindings);

    expect(context.getCache("testCache")).toBe(mockBindings.caches.testCache);
    expect(context.getEnv("TEST_VAR")).toBe("test-value");
    expect(context.raw).toBe(mockHonoContext);
  });

  it("throws when cache binding not found", () => {
    const context = createPlatformContext(mockHonoContext, mockBindings);

    expect(() => context.getCache("nonexistent")).toThrow(
      "Cache binding 'nonexistent' not found"
    );
  });
});
