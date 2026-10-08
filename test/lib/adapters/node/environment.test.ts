import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NodeEnvironmentAdapter } from "../../../../src/lib/adapters/node/environment";

describe("NodeEnvironmentAdapter", () => {
  let adapter: NodeEnvironmentAdapter;

  beforeEach(() => {
    adapter = new NodeEnvironmentAdapter();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns environment variables", () => {
    vi.stubEnv("TEST_VAR", "test-value");

    expect(adapter.get("TEST_VAR")).toBe("test-value");
  });

  it("returns empty string values", () => {
    vi.stubEnv("EMPTY_VAR", "");

    expect(adapter.get("EMPTY_VAR")).toBe("");
  });

  it("returns undefined for missing variables", () => {
    expect(adapter.get("NONEXISTENT_VAR")).toBeUndefined();
  });
});
