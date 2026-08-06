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
  if (includeConflict && code === "CONFLICT") return 409;
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

export function statusFromOwnershipErrorCode(code?: string): 403 | 404 | 500 {
  if (code === "NOT_FOUND") return 404;
  if (code === "FORBIDDEN" || code === "ACCOUNT_INACTIVE") return 403;
  return 500;
}
