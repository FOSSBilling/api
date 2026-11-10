import { prerelease, rcompare, valid } from "semver";

export interface ReleaseTag {
  tag: string;
  date?: string;
  is_latest?: boolean;
}

// Newest first by semver. Tags that aren't valid semver can't be ordered
// relative to the valid ones without risking a non-transitive comparator —
// e.g. an invalid tag comparing "equal" (via a caught exception) to two
// valid tags that are themselves not equal breaks Array#sort's assumption
// of a total order, and can leave later valid entries out of order even
// though every valid-to-valid comparison alone would have been correct.
// Partitioning the invalid tags out before sorting avoids that entirely;
// they're appended after, in their original relative order.
export function sortReleasesDescending<T extends ReleaseTag>(
  releases: T[]
): T[] {
  const withValidTag = releases.filter((r) => valid(r.tag) !== null);
  const withInvalidTag = releases.filter((r) => valid(r.tag) === null);
  return [
    ...withValidTag.sort((a, b) => rcompare(a.tag, b.tag)),
    ...withInvalidTag
  ];
}

// Explicit selection wins; older records without a selection prefer stable versions.
export function latestRelease<T extends ReleaseTag>(
  releases: readonly T[]
): T | undefined {
  const selected = releases.find((release) => release.is_latest === true);
  if (selected) return selected;
  const stable = releases.filter(
    (release) => valid(release.tag) && prerelease(release.tag) === null
  );
  return (stable.length ? stable : releases).reduce<T | undefined>(
    (latest, release) => {
      if (!latest) return release;
      const a = valid(release.tag),
        b = valid(latest.tag);
      const order = a && b ? rcompare(a, b) : a ? -1 : b ? 1 : 0;
      if (order) return order < 0 ? release : latest;
      const time = (date?: string) => {
        const value = Date.parse(date ?? "");
        return Number.isFinite(value) ? value : -Infinity;
      };
      return time(release.date) > time(latest.date) ? release : latest;
    },
    undefined
  );
}
