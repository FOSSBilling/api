import { describe, it, expect } from "vitest";
import { NodeEnvironmentAdapter } from "../../../../src/lib/adapters/node/environment";

// The adapter is `return process.env[key]`; one smoke test pins the
// IEnvironment contract (string passthrough, undefined for missing keys),
// with save/restore so the shared process.env is left untouched even on
// failure.
describe("NodeEnvironmentAdapter", () => {
  it("returns process.env values and undefined for missing keys", () => {
    const originalTestValue = process.env.FB_TEST_VAR;
    const originalMissingValue = process.env.FB_TEST_MISSING;
    try {
      process.env.FB_TEST_VAR = "test-value";
      delete process.env.FB_TEST_MISSING;

      const adapter = new NodeEnvironmentAdapter();
      expect(adapter.get("FB_TEST_VAR")).toBe("test-value");
      expect(adapter.get("FB_TEST_MISSING")).toBeUndefined();
    } finally {
      if (originalTestValue === undefined) {
        delete process.env.FB_TEST_VAR;
      } else {
        process.env.FB_TEST_VAR = originalTestValue;
      }
      if (originalMissingValue !== undefined) {
        process.env.FB_TEST_MISSING = originalMissingValue;
      }
    }
  });
});
