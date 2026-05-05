import { describe, expect, it } from "vitest";
import { normalizePublicCacheKey } from "../../src/lib/cache";

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
