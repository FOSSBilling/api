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

// The error classes are default-parameter setters over GitHubError; every
// defaulted value is exercised through classifyGitHubError below, which is
// the path production code actually consumes. No constructor describe here.
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
    expect(result.errorCode).toBe("auth_error");
    expect(result.url).toBe("https://api.github.com/test");
  });

  it("should classify 403 rate limit errors as RateLimitError", () => {
    const error = new Error("API rate limit exceeded");
    (error as Error & { status?: number }).status = 403;
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result.message).toBe("GitHub API rate limit exceeded");
    expect(result.httpStatus).toBe(403);
    expect(result.errorCode).toBe("rate_limit_error");
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
    expect(result.errorCode).toBe("auth_error");
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
    expect(result.errorCode).toBe("rate_limit_error");
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
    expect(result.errorCode).toBe("rate_limit_error");
  });

  it("should classify 429 errors as RateLimitError", () => {
    const error = { status: 429, message: "Too Many Requests" };
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result.message).toBe("GitHub API rate limit exceeded");
    expect(result.httpStatus).toBe(429);
    expect(result.errorCode).toBe("rate_limit_error");
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
    expect(result.errorCode).toBe("not_found_error");
    expect(result.url).toBe("https://api.github.com/test");
  });

  it("should classify timeout errors as NetworkError", () => {
    const error = new Error("Request timeout");
    const result = classifyGitHubError(error, "https://api.github.com/test");

    expect(result).toBeInstanceOf(NetworkError);
    expect(result.message).toBe("GitHub API request timed out");
    expect(result.url).toBe("https://api.github.com/test");
    expect(result.errorCode).toBe("network_error");
  });

  it("should classify network errors as NetworkError", () => {
    const error = new Error("Network connection failed");
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(NetworkError);
    expect(result.message).toBe("GitHub API network error");
    expect(result.errorCode).toBe("network_error");
  });

  it("should classify JSON parsing errors as ValidationError", () => {
    const error = new Error("Unexpected token in JSON");
    const result = classifyGitHubError(error);

    expect(result).toBeInstanceOf(ValidationError);
    expect(result.message).toBe("Invalid JSON response from GitHub API");
    expect(result.errorCode).toBe("validation_error");
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
});
