import { DatabaseResult } from "../../../lib/interfaces";
import { logError } from "../../../lib/logger";

// Drizzle wraps the real D1 driver error in a DrizzleError whose own
// .message is a generic "Failed to run the query '<sql>'" - the actual
// SQLite/D1 message (e.g. "UNIQUE constraint failed: ...") lives in
// .cause, not .message. Regex-matching driver error text (see
// isOwnerConflict/isPendingClaimConflict/isPendingTargetConflict) needs the
// whole chain, not just the outermost message.
export function errorMessageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join(" ");
}

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
