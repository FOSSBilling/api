import type { Context } from "hono";
import { DatabaseError } from "../../../../lib/interfaces";

// Routes that do not declare a 409 response pass false so unexpected conflict
// codes remain an internal error rather than escaping their OpenAPI contract.
export function statusFromErrorCode(
  code: string | undefined,
  includeConflict: false
): 404 | 500;
export function statusFromErrorCode(
  code?: string,
  includeConflict?: true
): 404 | 409 | 500;
export function statusFromErrorCode(
  code?: string,
  includeConflict = true
): 404 | 409 | 500 {
  if (code === "NOT_FOUND") return 404;
  if (
    includeConflict &&
    (code === "CONFLICT" ||
      code === "RESOURCE_QUOTA" ||
      code === "CONTENT_UNAVAILABLE")
  )
    return 409;
  return 500;
}

export function statusFromGithubErrorCode<T extends number>(
  code: string | undefined,
  fallback: T
): T | 422 | 429 | 503 {
  if (code === "GITHUB_ENTITY_UNSUPPORTED") return 422;
  if (code === "RATE_LIMITED") return 429;
  if (code === "SERVICE_UNAVAILABLE") return 503;
  return fallback;
}

// Guarded writes can fail for any of four reasons, including an account
// deactivated between requireActiveAuth() and the statement itself, so their
// routes need one mapper rather than a chain of ternaries per handler.
// includeNotFound follows statusFromErrorCode's includeConflict: a route that
// creates rather than addresses a row has no 404 to declare, and passes false
// so an unexpected NOT_FOUND cannot escape its OpenAPI contract.
export function statusFromWriteErrorCode(
  code: string | undefined,
  includeNotFound: false
): 403 | 409 | 500;
export function statusFromWriteErrorCode(
  code?: string,
  includeNotFound?: true
): 403 | 404 | 409 | 500;
export function statusFromWriteErrorCode(
  code?: string,
  includeNotFound = true
): 403 | 404 | 409 | 500 {
  if (code === "FORBIDDEN" || code === "ACCOUNT_INACTIVE") return 403;
  if (!includeNotFound && code === "NOT_FOUND") return 500;
  return statusFromErrorCode(code);
}

// Every handler reports a failed DatabaseResult the same way: the database's
// own message and code when it supplied one, a route-specific fallback and
// DATABASE_ERROR when it did not. The status stays at the call site, since
// each route documents its own set in the OpenAPI contract.
export function errorBody(
  error: DatabaseError | null | undefined,
  fallbackMessage: string
) {
  return {
    error: {
      message: error?.message ?? fallbackMessage,
      code: error?.code ?? "DATABASE_ERROR"
    }
  };
}

export function setContentRetryAfter(c: Context, code?: string): void {
  if (code === "ADMISSION_UNAVAILABLE" || code === "WRITE_RATE_MINUTE")
    c.header("Retry-After", "60");
  else if (code === "WRITE_RATE_DAY") c.header("Retry-After", "86400");
}

export function statusFromContentWriteError(
  code?: string
): 403 | 404 | 409 | 429 | 500 | 503 {
  if (code === "ADMISSION_UNAVAILABLE") return 503;
  if (code?.startsWith("WRITE_RATE_")) return 429;
  if (code === "RESOURCE_QUOTA" || code === "CONTENT_UNAVAILABLE") return 409;
  return statusFromWriteErrorCode(code);
}
export function statusFromContentReadError(code?: string): 404 | 409 | 500 {
  if (code === "CONTENT_UNAVAILABLE") return 409;
  return statusFromErrorCode(code, false);
}

export function statusFromContentCreateError(
  code?: string
): 403 | 409 | 429 | 500 | 503 {
  const status = statusFromContentWriteError(code);
  return status === 404 ? 500 : status;
}
