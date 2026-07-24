import { DatabaseResult } from "../../../lib/interfaces";
import { logError } from "../../../lib/logger";

// Logs the real error server-side and returns a generic message to the
// caller — DB exception text can leak schema/backend details otherwise.
export function databaseError(
  context: string,
  error: unknown
): DatabaseResult<never> {
  logError("extensions-v2", context, {
    error: error instanceof Error ? error.message : String(error)
  });
  return {
    data: null,
    error: { message: "A database error occurred", code: "DATABASE_ERROR" }
  };
}
