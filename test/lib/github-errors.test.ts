import { describe, it, expect } from "vitest";
import {
  GitHubError,
  AuthError,
  RateLimitError,
  NetworkError,
  NotFoundError,
  ValidationError,
  ErrorPriority,
  classifyGitHubError,
  getMostCriticalError
} from "../../src/lib/github-errors";

describe("GitHubError Classes", () => {
  it("should create GitHubError with all properties", () => {
    const error = new GitHubError(
      "Test error",
      500,
      "test_error",
      ErrorPriority.MEDIUM,
      "https://api.github.com/test",
      { detail: "more info" }
    );

    expect(error.message).toBe("Test error");
    expect(error.httpStatus).toBe(500);
    expect(error.errorCode).toBe("test_error");
    expect(error.priority).toBe(ErrorPriority.MEDIUM);
    expect(error.url).toBe("https://api.github.com/test");
    expect(error.details).toEqual({ detail: "more info" });
    expect(error.name).toBe("GitHubError");
  });

  it("should create AuthError with default priority CRITICAL", () => {
    const error = new AuthError(
      "Unauthorized",
      401,
      "https://api.github.com/test"
    );

    expect(error.message).toBe("Unauthorized");
    expect(error.httpStatus).toBe(401);
    expect(error.errorCode).toBe("auth_error");
    expect(error.priority).toBe(ErrorPriority.CRITICAL);
    expect(error.url).toBe("https://api.github.com/test");
  });

  it("should create RateLimitError with default priority CRITICAL", () => {
    const error = new RateLimitError("Rate limited", 403);

    expect(error.message).toBe("Rate limited");
    expect(error.httpStatus).toBe(403);
    expect(error.errorCode).toBe("rate_limit_error");
    expect(error.priority).toBe(ErrorPriority.CRITICAL);
  });

  it("should create NetworkError with priority HIGH", () => {
    const error = new NetworkError(
      "Network failure",
      "https://api.github.com/test"
    );

    expect(error.message).toBe("Network failure");
    expect(error.httpStatus).toBeUndefined();
    expect(error.errorCode).toBe("network_error");
    expect(error.priority).toBe(ErrorPriority.HIGH);
    expect(error.url).toBe("https://api.github.com/test");
  });

  it("should create NotFoundError with priority MEDIUM", () => {
    const error = new NotFoundError("Not found", 404);

    expect(error.message).toBe("Not found");
    expect(error.httpStatus).toBe(404);
    expect(error.errorCode).toBe("not_found_error");
    expect(error.priority).toBe(ErrorPriority.MEDIUM);
  });

  it("should create ValidationError with priority LOW", () => {
    const error = new ValidationError("Invalid data", { field: "value" });

    expect(error.message).toBe("Invalid data");
    expect(error.httpStatus).toBeUndefined();
    expect(error.errorCode).toBe("validation_error");
    expect(error.priority).toBe(ErrorPriority.LOW);
    expect(error.details).toEqual({ field: "value" });
  });
});

describe("classifyGitHubError", () => {
  it("should return original error if already a GitHubError", () => {
    const originalError = new AuthError("Already classified");
    const result = classifyGitHubError(originalError);

    expect(result).toBe(originalError);
  });

  it("should classify 401 errors as AuthError", () => {
    const error = { status: 401, message: "Bad credentials" };
    const result = classifyGitHubError(error, "https://api.github.com/test");

    expect(result).toBeInstanceOf(AuthError);
    expect(result.message).toBe("Bad credentials");
    expect(result.httpStatus).toBe(401);
    expect(result.url).toBe("https://api.github.com/test");
  });

  it("should classify 403 rate limit errors as RateLimitError", () => {
    const error = new Error("API rate limit exceeded");
    (error as Error & { status?: number }).status = 403;
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result.message).toBe("GitHub API rate limit exceeded");
    expect(result.httpStatus).toBe(403);
  });

  it("should classify 403 rate limit errors case-insensitively", () => {
    const error = new Error("api RATE LIMIT exceeded");
    (error as Error & { status?: number }).status = 403;
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result.message).toBe("GitHub API rate limit exceeded");
  });

  // A bare 403 carries no rate-limit evidence, so it is an authorization
  // failure. Reporting it as a rate limit would tell callers to back off and
  // retry a request that cannot succeed.
  it("should classify 403 non-rate-limit errors as AuthError with original message", () => {
    const error = { status: 403, message: "Repository access denied" };
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(AuthError);
    expect(result.message).toBe("Repository access denied");
    expect(result.httpStatus).toBe(403);
  });

  it("should classify a 403 with an exhausted quota header as RateLimitError", () => {
    const error = {
      status: 403,
      message: "Forbidden",
      response: { headers: { "x-ratelimit-remaining": "0" } }
    };
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result.message).toBe("GitHub API rate limit exceeded");
    expect(result.httpStatus).toBe(403);
  });

  it("should classify 429 errors as RateLimitError", () => {
    const error = { status: 429, message: "Too Many Requests" };
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result.message).toBe("GitHub API rate limit exceeded");
    expect(result.httpStatus).toBe(429);
  });

  it("should classify 404 errors as NotFoundError", () => {
    const error = { status: 404, message: "Not found" };
    const result = classifyGitHubError(error, "https://api.github.com/test");

    expect(result).toBeInstanceOf(NotFoundError);
    expect(result.message).toBe("Not found");
    expect(result.httpStatus).toBe(404);
    expect(result.url).toBe("https://api.github.com/test");
  });

  it("should classify timeout errors as NetworkError", () => {
    const error = new Error("Request timeout");
    const result = classifyGitHubError(error, "https://api.github.com/test");

    expect(result).toBeInstanceOf(NetworkError);
    expect(result.message).toBe("GitHub API request timed out");
    expect(result.url).toBe("https://api.github.com/test");
  });

  it("should classify network errors as NetworkError", () => {
    const error = new Error("Network connection failed");
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(NetworkError);
    expect(result.message).toBe("GitHub API network error");
  });

  it("should classify JSON parsing errors as ValidationError", () => {
    const error = new Error("Unexpected token in JSON");
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(ValidationError);
    expect(result.message).toBe("Invalid JSON response from GitHub API");
    expect(result.details).toEqual({
      originalMessage: "Unexpected token in JSON"
    });
  });

  it("should classify unknown errors as GitHubError with priority HIGH", () => {
    const error = new Error("Unknown error");
    const result = classifyGitHubError(error, "https://api.github.com/test");

    expect(result).toBeInstanceOf(GitHubError);
    expect(result.message).toBe("Unknown error");
    expect(result.errorCode).toBe("unknown_error");
    expect(result.priority).toBe(ErrorPriority.HIGH);
    expect(result.url).toBe("https://api.github.com/test");
  });

  it("should handle non-Error objects", () => {
    const error = "String error";
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(GitHubError);
    expect(result.message).toBe("String error");
  });

  it("should handle null errors", () => {
    const result = classifyGitHubError(null);

    expect(result).toBeInstanceOf(GitHubError);
    expect(result.message).toBe("null");
  });
});

describe("getMostCriticalError", () => {
  it("should return null for empty array", () => {
    const result = getMostCriticalError([]);

    expect(result).toBeNull();
  });

  it("should return single error from array", () => {
    const error = new ValidationError("Test");
    const result = getMostCriticalError([error]);

    expect(result).toBe(error);
  });

  it("should select CRITICAL over other priorities", () => {
    const errors = [
      new ValidationError("Low"),
      new NetworkError("High"),
      new AuthError("Critical")
    ];

    const result = getMostCriticalError(errors);

    expect(result).toBeInstanceOf(AuthError);
    expect(result?.priority).toBe(ErrorPriority.CRITICAL);
  });

  it("should select HIGH over MEDIUM and LOW", () => {
    const errors = [
      new ValidationError("Low"),
      new NetworkError("High"),
      new NotFoundError("Medium")
    ];

    const result = getMostCriticalError(errors);

    expect(result).toBeInstanceOf(NetworkError);
    expect(result?.priority).toBe(ErrorPriority.HIGH);
  });

  it("should select MEDIUM over LOW", () => {
    const errors = [new ValidationError("Low"), new NotFoundError("Medium")];

    const result = getMostCriticalError(errors);

    expect(result).toBeInstanceOf(NotFoundError);
    expect(result?.priority).toBe(ErrorPriority.MEDIUM);
  });

  it("should handle same priority by returning first", () => {
    const error1 = new ValidationError("First");
    const error2 = new ValidationError("Second");

    const result = getMostCriticalError([error1, error2]);

    expect(result).toBe(error1);
  });

  it("should select error with lower priority number", () => {
    const error = new GitHubError(
      "0",
      undefined,
      "test",
      ErrorPriority.CRITICAL
    );
    const errors = [
      error,
      new GitHubError("1", undefined, "test", ErrorPriority.HIGH),
      new GitHubError("2", undefined, "test", ErrorPriority.MEDIUM),
      new GitHubError("3", undefined, "test", ErrorPriority.LOW)
    ];

    const result = getMostCriticalError(errors);

    expect(result?.priority).toBe(ErrorPriority.CRITICAL);
  });
});
