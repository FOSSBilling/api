import { describe, it, expect, beforeEach } from "vitest";
import { CloudflareEnvironmentAdapter } from "../../../../src/lib/adapters/cloudflare/environment";

// One test per filtering rule: strings pass through, everything else (any
// non-string binding the env object may carry) is hidden behind the
// IEnvironment contract.
describe("CloudflareEnvironmentAdapter", () => {
  let adapter: CloudflareEnvironmentAdapter;

  beforeEach(() => {
    const env = {
      STRING_VAR: "test-value",
      EMPTY_VAR: "",
      NUMBER_VAR: 123,
      OBJECT_VAR: { key: "value" }
    };

    adapter = new CloudflareEnvironmentAdapter(env as Record<string, unknown>);
  });

  it("returns string values", () => {
    expect(adapter.get("STRING_VAR")).toBe("test-value");
  });

  it("returns empty string values", () => {
    expect(adapter.get("EMPTY_VAR")).toBe("");
  });

  it("hides non-string values", () => {
    expect(adapter.get("NUMBER_VAR")).toBeUndefined();
    expect(adapter.get("OBJECT_VAR")).toBeUndefined();
  });

  it("returns undefined for missing keys", () => {
    expect(adapter.get("NONEXISTENT_VAR")).toBeUndefined();
  });
});
