import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logError, logWarn, logInfo } from "../../src/lib/logger";

// console[level]("[SERVICE]", message, json?) - the context is a structured
// trailing argument so Workers observability keeps it filterable; join the
// args so assertions read like the emitted line.
function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.at(-1)!.map(String).join(" ");
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
    it("logError goes to console.error with service prefix", () => {
      logError("TEST_SERVICE", "Error occurred");

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(logged(consoleErrorSpy)).toContain(
        "[TEST_SERVICE] Error occurred"
      );
    });

    it("logWarn and logInfo go to their own console methods", () => {
      logWarn("TEST_SERVICE", "Warning message");
      logInfo("TEST_SERVICE", "Info message");

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("passes the context as a structured trailing argument", () => {
      const context = { userId: 123, action: "test" };
      logError("TEST_SERVICE", "Error occurred", context);

      const call = consoleErrorSpy.mock.calls[0] as unknown[];
      expect(call[0]).toBe("[TEST_SERVICE]");
      expect(call[1]).toBe("Error occurred");
      expect(call[2]).toBe(JSON.stringify(context));
    });

    it("omits the context argument when not provided", () => {
      logError("TEST_SERVICE", "Error occurred");

      const call = consoleErrorSpy.mock.calls[0] as unknown[];
      expect(call).toHaveLength(2);
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
