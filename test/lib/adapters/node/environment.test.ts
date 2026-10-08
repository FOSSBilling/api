import { describe, it, expect } from "vitest";
import { NodeEnvironmentAdapter } from "../../../../src/lib/adapters/node/environment";

// The adapter is `return process.env[key]`; one smoke test pins the
// IEnvironment contract (string passthrough, undefined for missing keys).
describe("NodeEnvironmentAdapter", () => {
  it("returns process.env values and undefined for missing keys", () => {
    process.env.FB_TEST_VAR = "test-value";

    const adapter = new NodeEnvironmentAdapter();
    expect(adapter.get("FB_TEST_VAR")).toBe("test-value");
    expect(adapter.get("FB_TEST_MISSING")).toBeUndefined();

    delete process.env.FB_TEST_VAR;
  });
});
