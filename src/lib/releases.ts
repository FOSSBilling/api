import { rcompare, valid } from "semver";

export interface ReleaseTag {
  tag: string;
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
