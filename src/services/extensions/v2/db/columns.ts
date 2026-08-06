// SQLite has no boolean type, so the nullable flag columns in db/schema.ts are
// integers where NULL means "not determined yet" rather than false. Preserving
// that distinction matters for github_org_verified, where "unknown" and "no"
// lead to different moderation outcomes.
export function optionalBool(
  value: number | null | undefined
): boolean | undefined {
  return value == null ? undefined : value === 1;
}
