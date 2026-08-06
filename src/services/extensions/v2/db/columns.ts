// SQLite has no boolean type, so the nullable flag columns in db/schema.ts are
// integers where NULL means "not determined yet" rather than false. Both
// developer and claim rows expose that as an optional boolean, and the two
// must agree - github_org_verified in particular is a moderation signal where
// "unknown" and "no" mean different things.
export function optionalBool(
  value: number | null | undefined
): boolean | undefined {
  return value == null ? undefined : value === 1;
}
