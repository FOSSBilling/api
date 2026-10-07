import { sql } from "drizzle-orm";
import { developers } from "./schema";

// Approval is valid only while its revision matches the profile.
export function developerIsApproved(row: {
  approvedAt: string | null;
  approvedRevision: number | null;
  contentRevision: number;
}): boolean {
  return (
    row.approvedAt !== null &&
    row.approvedRevision !== null &&
    row.approvedRevision === row.contentRevision
  );
}

export function developerApprovalPredicate() {
  return sql`${developers.approvedAt} IS NOT NULL
    AND ${developers.approvedRevision} IS NOT NULL
    AND ${developers.approvedRevision} = ${developers.contentRevision}`;
}
