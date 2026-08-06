import { DatabaseResult } from "../../../../lib/interfaces";
import { logError } from "../../../../lib/logger";

// Drizzle wraps the real D1 driver error in a DrizzleError whose own
// .message is a generic "Failed to run the query '<sql>'" - the actual
// SQLite/D1 message (e.g. "UNIQUE constraint failed: ...") lives in
// .cause, not .message. Regex-matching driver error text (see
// the ownership/id conflict classifiers need the whole chain, not just the
// outermost message.
export function errorMessageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join(" ");
}

// Every unique-constraint classifier below matches D1 driver message text,
// which means each one is coupled to a physical index or table name in
// db/schema.ts with nothing but this comment linking them. Keep them all
// here so a migration that renames one has a single place to check.
const uniqueConstraintMatcher = (target: RegExp) => (error: unknown) =>
  new RegExp(`UNIQUE constraint failed.*${target.source}`, "i").test(
    errorMessageChain(error)
  );

// Matches the SQLite/D1 message for the unique owner index. Several
// ownership workflows need to translate this race into the same conflict
// response.
export const isDeveloperOwnerConflict =
  uniqueConstraintMatcher(/owner_user_id/);

// A concurrent first-time profile creation can lose the developers primary-key
// race after both requests pass the cheap existence check. Translate that
// SQLite/D1 constraint failure into the same conflict returned by the
// pre-flight check instead of exposing it as a generic database error.
export const isDeveloperIdConflict = uniqueConstraintMatcher(/developers\.id/);

// A second pending claim for the same developer loses the partial unique
// index race; the route reports it as the same conflict the pre-flight
// check would have.
export const isPendingClaimConflict =
  uniqueConstraintMatcher(/developer_claims/);

// Same race for a second pending submission targeting one extension.
export const isPendingTargetConflict = uniqueConstraintMatcher(
  /extension_submissions/
);

// Logs the real error server-side and returns a generic message to the
// caller — DB exception text can leak schema/backend details otherwise.
export function databaseError(
  context: string,
  error: unknown
): DatabaseResult<never> {
  logError("extensions-v2", context, {
    error: error instanceof Error ? errorMessageChain(error) : String(error)
  });
  return {
    data: null,
    error: { message: "A database error occurred", code: "DATABASE_ERROR" }
  };
}
