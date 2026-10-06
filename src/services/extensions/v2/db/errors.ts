import { DatabaseError } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { UsersDatabase } from "./users";
import { DatabaseResult } from "../../../../lib/interfaces";
import { logInfo, logError } from "../../../../lib/logger";

// Drizzle wraps driver errors; constraint classifiers inspect the cause chain.
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

// The ownership-transfer and claim-approval batches end with an assertion
// statement that sets ownership_epoch = 0 when the preceding claim matched no
// rows, deliberately violating the column's CHECK so D1 rolls the whole batch
// back (see acceptTransfer/approveClaim). That rollback is the designed
// signal for "this token was replayed", not a fault, so it is recognised here
// rather than reported as a database error.
//
// Unlike the UNIQUE matchers above this one cannot currently be replaced by a
// guard: it is how a multi-statement batch reports failure atomically, and
// D1 exposes no other way to abort one. Changing it means redesigning the
// batch protocol, not swapping a classifier.
export const isOwnershipEpochRollback = (error: unknown) =>
  /CHECK constraint failed.*ownership_epoch/i.test(errorMessageChain(error));

// A concurrent first-time profile creation can lose the developers primary-key
// race after both requests pass the cheap existence check. Translate that
// SQLite/D1 constraint failure into the same conflict returned by the
// pre-flight check instead of exposing it as a generic database error.
export const isDeveloperIdConflict = uniqueConstraintMatcher(/developers\.id/);

// Log safe driver diagnostics; exception messages can contain SQL and content.
export function databaseError(
  context: string,
  error: unknown
): DatabaseResult<never> {
  let cause = error;
  while (cause instanceof Error && cause.cause instanceof Error)
    cause = cause.cause;
  const message = cause instanceof Error ? cause.message : "";
  const policy = [
    [
      "extension_write_rate_minute",
      "WRITE_RATE_MINUTE",
      "Five proposals per rolling minute allowed"
    ],
    [
      "extension_write_rate_day",
      "WRITE_RATE_DAY",
      "Fifty proposals per rolling day allowed"
    ],
    [
      "extension_resource_quota",
      "RESOURCE_QUOTA",
      "The retained extension resource quota is exhausted"
    ],
    [
      "extension_content_size",
      "CONFLICT",
      "Extension content must not exceed 256 KiB"
    ]
  ].find(([marker]) => message.includes(marker));
  if (policy) {
    logInfo("extensions-v2", "Resource admission rejected", {
      reason: policy[1]
    });
    return { data: null, error: { code: policy[1], message: policy[2] } };
  }
  const driverCode =
    cause instanceof Error && "code" in cause ? cause.code : undefined;
  const backendCode =
    typeof driverCode === "number"
      ? driverCode
      : typeof driverCode === "string" &&
          /^[A-Z][A-Z0-9_]{0,63}$/.test(driverCode)
        ? driverCode
        : message.match(/\b(?:SQLITE|D1)_[A-Z_]+\b/)?.[0];
  logError("extensions-v2", context, {
    reason: "backend_failure",
    error_type:
      cause instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(cause.name)
        ? cause.name
        : "UnknownError",
    backend_code: backendCode
  });
  return {
    data: null,
    error: { message: "A database error occurred", code: "DATABASE_ERROR" }
  };
}

// Content insertion and its durable budget share one transaction. A backend
// failure means admission is unavailable; policy rejections retain their code.
export function contentAdmissionError(
  context: string,
  error: unknown
): DatabaseResult<never> {
  const result = databaseError(context, error);
  return result.error?.code === "DATABASE_ERROR"
    ? {
        data: null,
        error: {
          code: "ADMISSION_UNAVAILABLE",
          message: "Write admission unavailable"
        }
      }
    : result;
}

// Every guarded write in this service repeats an active-account check inside
// its own statement, because requireActiveAuth() can only reject before the
// write. When such a statement affects no rows the diagnosis has to ask this
// first: otherwise a deactivation lands in whatever branch the diagnosis falls
// through to, and the caller is told their edit conflicted rather than that
// their account is gone.
export async function inactiveActorError(
  db: ExtensionsDb,
  userId: string
): Promise<DatabaseError | null> {
  const { data, error } = await new UsersDatabase(db).isActive(userId);
  if (error) return error;
  return data
    ? null
    : { message: "Active account required", code: "ACCOUNT_INACTIVE" };
}

// Diagnose a failed commit-time moderator guard before workflow conflicts.
// Activity takes precedence so deactivation retains ACCOUNT_INACTIVE.
export async function moderatorActorError(
  db: ExtensionsDb,
  userId: string
): Promise<DatabaseError | null> {
  const { data, error } = await new UsersDatabase(db).moderatorAccess(userId);
  if (error) return error;
  if (!data?.active) {
    return { message: "Active account required", code: "ACCOUNT_INACTIVE" };
  }
  return data.moderator
    ? null
    : { message: "Moderator access required", code: "FORBIDDEN" };
}
