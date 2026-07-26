import { describe, expect, it } from "vitest";
import { sortReleasesDescending } from "../../src/lib/releases";

function tag(t: string) {
  return { tag: t };
}

describe("sortReleasesDescending", () => {
  it("sorts valid semver tags newest first", () => {
    expect(
      sortReleasesDescending([tag("1.0.0"), tag("2.0.0"), tag("1.5.0")])
    ).toEqual([tag("2.0.0"), tag("1.5.0"), tag("1.0.0")]);
  });

  it("keeps later valid tags correctly ordered around an invalid tag between them", () => {
    // A naive try/catch comparator can treat "invalid" as "equal" to both
    // of its valid neighbors even though 2.0.0 and 1.0.0 aren't equal to
    // each other, breaking sort's assumption of a total order.
    expect(
      sortReleasesDescending([tag("2.0.0"), tag("invalid"), tag("1.0.0")])
    ).toEqual([tag("2.0.0"), tag("1.0.0"), tag("invalid")]);
  });

  it("appends invalid tags after all valid ones, preserving their relative order", () => {
    expect(sortReleasesDescending([tag("b"), tag("1.0.0"), tag("a")])).toEqual([
      tag("1.0.0"),
      tag("b"),
      tag("a")
    ]);
  });
});
