import { describe, it, expect } from "vitest";
import { createPlatformContext } from "../../src/lib/context";
import { IPlatformBindings } from "../../src/lib/interfaces";

// createPlatformContext is an object literal over the bindings; the only
// logic of its own is the missing-binding throw, so that is what is
// asserted here. The accessors are exercised end-to-end by every suite
// that boots the real app.
describe("createPlatformContext", () => {
  const mockBindings: IPlatformBindings = {
    queues: { testQueue: { send: async () => {} } },
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

  it("exposes the binding accessors", () => {
    const context = createPlatformContext(mockBindings, () => {});

    expect(context.getCache("testCache")).toBe(mockBindings.caches.testCache);
    expect(context.getEnv("TEST_VAR")).toBe("test-value");
    expect(context.getQueue("testQueue")).toBe(mockBindings.queues!.testQueue);
  });

  it("throws when a queue binding is missing", () => {
    const context = createPlatformContext(mockBindings, () => {});
    expect(() => context.getQueue("missing")).toThrow(
      "Queue binding 'missing' not found"
    );
  });
  it("throws when cache binding not found", () => {
    const context = createPlatformContext(mockBindings, () => {});

    expect(() => context.getCache("nonexistent")).toThrow(
      "Cache binding 'nonexistent' not found"
    );
  });
});
