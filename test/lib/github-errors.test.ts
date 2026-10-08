import { describe, it, expect } from "vitest";
import {
  GitHubError,
  AuthError,
  RateLimitError,
  NetworkError,
  NotFoundError,
  ValidationError,
  classifyGitHubError
} from "../../src/lib/github-errors";

describe("GitHubError Classes", () => {
  it("should create GitHubError with all properties", () => {
    const error = new GitHubError(
      "Test error",
      500,
      "test_error",
      "https://api.github.com/test"
    );

    expect(error.message).toBe("Test error");
    expect(error.httpStatus).toBe(500);
    expect(error.errorCode).toBe("test_error");
    expect(error.url).toBe("https://api.github.com/test");
    expect(error.name).toBe("GitHubError");
  });

  it("should create AuthError with defaults", () => {
    const error = new AuthError(
      "Unauthorized",
      401,
      "https://api.github.com/test"
    );

    expect(error.message).toBe("Unauthorized");
    expect(error.httpStatus).toBe(401);
    expect(error.errorCode).toBe("auth_error");
    expect(error.url).toBe("https://api.github.com/test");
  });

  it("should create RateLimitError", () => {
    const error = new RateLimitError("Rate limited", 403);

    expect(error.message).toBe("Rate limited");
    expect(error.httpStatus).toBe(403);
    expect(error.errorCode).toBe("rate_limit_error");
  });

  it("should create NetworkError without a status", () => {
    const error = new NetworkError(
      "Network failure",
      "https://api.github.com/test"
    );

    expect(error.message).toBe("Network failure");
    expect(error.httpStatus).toBeUndefined();
    expect(error.errorCode).toBe("network_error");
    expect(error.url).toBe("https://api.github.com/test");
  });

  it("should create NotFoundError", () => {
    const error = new NotFoundError("Not found", 404);

    expect(error.message).toBe("Not found");
    expect(error.httpStatus).toBe(404);
    expect(error.errorCode).toBe("not_found_error");
  });

  it("should create ValidationError", () => {
    const error = new ValidationError("Invalid data");

    expect(error.message).toBe("Invalid data");
    expect(error.httpStatus).toBeUndefined();
    expect(error.errorCode).toBe("validation_error");
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

  // Regression: the rate-limit text was read from String(error), which is
  // "[object Object]" for a non-Error throw. That was invisible while every
  // 403 became a RateLimitError; once the message decides the class, it turned
  // a real rate limit into an AuthError.
  it("should detect a rate limit on a non-Error 403 payload", () => {
    const error = { status: 403, message: "API rate limit exceeded" };
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(RateLimitError);
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

  // A 5xx has no dedicated class, but dropping its status would make an
  // upstream outage indistinguishable from a transport failure that never
  // reached GitHub. extensions/v2 branches on exactly that difference.
  it("should retain the status for unrecognised HTTP statuses", () => {
    for (const status of [500, 502, 503]) {
      const error = Object.assign(new Error("upstream failure"), { status });
      const result = classifyGitHubError(error);

      expect(result.errorCode).toBe("unknown_error");
      expect(result.httpStatus).toBe(status);
    }
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
  });

  it("should classify unknown errors as GitHubError", () => {
    const error = new Error("Unknown error");
    const result = classifyGitHubError(error, "https://api.github.com/test");

    expect(result).toBeInstanceOf(GitHubError);
    expect(result.message).toBe("Unknown error");
    expect(result.errorCode).toBe("unknown_error");
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
