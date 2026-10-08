import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logError, logWarn, logInfo } from "../../src/lib/logger";

// console[level] receives one structured object ({ service, message,
// context? }) - the shape Workers Logs serializes to filterable JSON.
// Helpers here pull the logged entry back out of the spy.
function loggedEntries(spy: {
  mock: { calls: unknown[][] };
}): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

function logged(spy: { mock: { calls: unknown[][] } }): string {
  return JSON.stringify(loggedEntries(spy).at(-1));
}

describe("Logger", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleInfoSpy.mockRestore();
  });

  describe("routing and format", () => {
    // One routing case per console method; the negative cross-assertions
    // only re-prove console dispatch.
    it("logError goes to console.error as a structured entry", () => {
      logError("TEST_SERVICE", "Error occurred");

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const entry = loggedEntries(consoleErrorSpy)[0];
      expect(entry).toEqual({
        service: "TEST_SERVICE",
        message: "Error occurred"
      });
    });

    it("logWarn and logInfo go to their own console methods", () => {
      logWarn("TEST_SERVICE", "Warning message");
      logInfo("TEST_SERVICE", "Info message");

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("carries the redacted context as a structured field", () => {
      const context = { userId: 123, action: "test" };
      logError("TEST_SERVICE", "Error occurred", context);

      const entry = loggedEntries(consoleErrorSpy)[0];
      expect(entry).toEqual({
        service: "TEST_SERVICE",
        message: "Error occurred",
        context
      });
    });

    it("omits the context field when not provided", () => {
      logError("TEST_SERVICE", "Error occurred");

      const entry = loggedEntries(consoleErrorSpy)[0];
      expect(entry).toEqual({
        service: "TEST_SERVICE",
        message: "Error occurred"
      });
    });
  });

  describe("Data Redaction", () => {
    it("redacts Bearer tokens in context", () => {
      const context = { authorization: "Bearer secret-token-12345" };
      logError("TEST_SERVICE", "Error occurred", context);

      expect(logged(consoleErrorSpy)).toContain("Bearer [REDACTED]");
      expect(logged(consoleErrorSpy)).not.toContain("secret-token-12345");
    });

    it("redacts token/key/secret/password keys case-insensitively", () => {
      const context = {
        api_token: "secret",
        API_KEY: "secret",
        SecretKey: "secret2",
        password: "secret3",
        visible: "value"
      };
      logInfo("TEST_SERVICE", "Message", context);

      expect(logged(consoleInfoSpy)).not.toContain("secret");
      expect(logged(consoleInfoSpy)).toContain("[REDACTED]");
      expect(logged(consoleInfoSpy)).toContain('"visible":"value"');
    });

    it("redacts nested and array-sensitive data", () => {
      const context = {
        user: { password: "secret123", name: "John" },
        items: [{ token: "secret1" }, { name: "safe" }],
        headers: { authorization: "Bearer token123" }
      };
      logInfo("TEST_SERVICE", "Message", context);

      expect(logged(consoleInfoSpy)).not.toContain("secret123");
      expect(logged(consoleInfoSpy)).not.toContain("secret1");
      expect(logged(consoleInfoSpy)).not.toContain("token123");
      expect(logged(consoleInfoSpy)).toContain('"name":"John"');
      expect(logged(consoleInfoSpy)).toContain('"name":"safe"');
      expect(logged(consoleInfoSpy)).toContain("Bearer [REDACTED]");
    });
  });
});
