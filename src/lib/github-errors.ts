export enum ErrorPriority {
  CRITICAL = 0,
  HIGH = 1,
  MEDIUM = 2,
  LOW = 3
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly errorCode?: string,
    public readonly priority: ErrorPriority = ErrorPriority.MEDIUM,
    public readonly url?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AuthError extends GitHubError {
  constructor(message: string, httpStatus: number = 401, url?: string) {
    super(message, httpStatus, "auth_error", ErrorPriority.CRITICAL, url);
  }
}

export class RateLimitError extends GitHubError {
  constructor(message: string, httpStatus: number = 403, url?: string) {
    super(message, httpStatus, "rate_limit_error", ErrorPriority.CRITICAL, url);
  }
}

export class NetworkError extends GitHubError {
  constructor(message: string, url?: string) {
    super(message, undefined, "network_error", ErrorPriority.HIGH, url);
  }
}

export class NotFoundError extends GitHubError {
  constructor(message: string, httpStatus: number = 404, url?: string) {
    super(message, httpStatus, "not_found_error", ErrorPriority.MEDIUM, url);
  }
}

export class ValidationError extends GitHubError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(
      message,
      undefined,
      "validation_error",
      ErrorPriority.LOW,
      undefined,
      details
    );
  }
}

export function classifyGitHubError(error: unknown, url?: string): GitHubError {
  if (error instanceof GitHubError) {
    return error;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);

  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown>;

    if (
      typeof err.status === "number" &&
      err.status === 401 &&
      typeof err.message === "string"
    ) {
      return new AuthError(err.message, err.status, url);
    }

    // GitHub returns 429 for secondary rate limits, and 403 for both primary
    // rate limits and plain authorization failures. Only the message text or
    // an exhausted x-ratelimit-remaining distinguishes the two; a bare 403 is
    // an authorization problem, and calling it a rate limit would have callers
    // back off and retry a request that will never succeed.
    if (typeof err.status === "number" && err.status === 429) {
      return new RateLimitError("GitHub API rate limit exceeded", 429, url);
    }

    if (
      typeof err.status === "number" &&
      err.status === 403 &&
      typeof err.message === "string"
    ) {
      const response = err.response as
        { headers?: Record<string, string> } | undefined;
      // err.message, not errorMessage: the latter is String(error) for a
      // non-Error throw, which stringifies to "[object Object]" and would hide
      // the "rate limit" text this branch depends on. Getting that wrong now
      // costs a misclassification rather than just a reworded message, because
      // this test is what separates RateLimitError from AuthError.
      const rateLimited =
        err.message.toLowerCase().includes("rate limit") ||
        response?.headers?.["x-ratelimit-remaining"] === "0";
      return rateLimited
        ? new RateLimitError("GitHub API rate limit exceeded", err.status, url)
        : new AuthError(err.message, err.status, url);
    }

    if (
      typeof err.status === "number" &&
      err.status === 404 &&
      typeof err.message === "string"
    ) {
      return new NotFoundError(err.message, err.status, url);
    }
  }

  if (errorMessage.toLowerCase().includes("timeout")) {
    return new NetworkError("GitHub API request timed out", url);
  }

  if (errorMessage.toLowerCase().includes("network")) {
    return new NetworkError("GitHub API network error", url);
  }

  if (errorMessage.toLowerCase().includes("json")) {
    return new ValidationError("Invalid JSON response from GitHub API", {
      originalMessage: errorMessage
    });
  }

  return new GitHubError(
    errorMessage,
    undefined,
    "unknown_error",
    ErrorPriority.HIGH,
    url
  );
}

export function getMostCriticalError(
  errors: GitHubError[]
): GitHubError | null {
  if (errors.length === 0) {
    return null;
  }

  return errors.reduce((mostCritical, current) =>
    current.priority < mostCritical.priority ? current : mostCritical
  );
}
