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
    it("logError goes to console.error with service and level prefix", () => {
      logError("TEST_SERVICE", "Error occurred");

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(logged(consoleErrorSpy)).toContain(
        "[TEST_SERVICE] Error occurred"
      );
    });

    it("logWarn goes to console.warn", () => {
      logWarn("TEST_SERVICE", "Warning message");

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(logged(consoleWarnSpy)).toContain("Warning message");
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
    });

    it("logInfo goes to console.info", () => {
      logInfo("TEST_SERVICE", "Info message");

      expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
      expect(logged(consoleInfoSpy)).toContain("Info message");
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
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

    it("redacts 'token' keys in context", () => {
      const context = { api_token: "secret", other: "value" };
      logInfo("TEST_SERVICE", "Message", context);

      expect(logged(consoleInfoSpy)).toContain('"api_token":"[REDACTED]"');
      expect(logged(consoleInfoSpy)).toContain('"other":"value"');
    });

    it("redacts 'key' keys in context", () => {
      const context = { secret_key: "secret", public_key: "public" };
      logInfo("TEST_SERVICE", "Message", context);

      expect(logged(consoleInfoSpy)).toContain('"secret_key":"[REDACTED]"');
      expect(logged(consoleInfoSpy)).toContain('"public_key":"[REDACTED]"');
    });

    it("redacts 'secret' keys in context", () => {
      const context = { my_secret: "secret", visible: "value" };
      logInfo("TEST_SERVICE", "Message", context);

      expect(logged(consoleInfoSpy)).toContain('"my_secret":"[REDACTED]"');
    });

    it("redacts 'password' keys in context", () => {
      const context = { password: "secret123", username: "user" };
      logInfo("TEST_SERVICE", "Message", context);

      expect(logged(consoleInfoSpy)).toContain('"password":"[REDACTED]"');
    });

    it("redacts keys case-insensitively", () => {
      const context = {
        API_KEY: "secret",
        SecretKey: "secret2",
        PASSWORD: "secret3"
      };
      logInfo("TEST_SERVICE", "Message", context);

      expect(logged(consoleInfoSpy)).not.toContain("secret");
      expect(logged(consoleInfoSpy)).toContain("[REDACTED]");
    });

    it("redacts nested sensitive data", () => {
      const context = {
        user: { password: "secret123", name: "John" },
        config: { api_key: "key456" }
      };
      logInfo("TEST_SERVICE", "Message", context);

      expect(logged(consoleInfoSpy)).not.toContain("secret123");
      expect(logged(consoleInfoSpy)).not.toContain("key456");
      expect(logged(consoleInfoSpy)).toContain('"name":"John"');
    });

    it("redacts sensitive data in arrays", () => {
      const context = {
        items: [{ token: "secret1" }, { token: "secret2" }, { name: "safe" }]
      };
      logInfo("TEST_SERVICE", "Message", context);

      expect(logged(consoleInfoSpy)).not.toContain("secret1");
      expect(logged(consoleInfoSpy)).not.toContain("secret2");
      expect(logged(consoleInfoSpy)).toContain('"name":"safe"');
    });

    it("handles nested strings with Bearer tokens", () => {
      const context = { headers: { authorization: "Bearer token123" } };
      logInfo("TEST_SERVICE", "Message", context);

      expect(logged(consoleInfoSpy)).toContain("Bearer [REDACTED]");
      expect(logged(consoleInfoSpy)).not.toContain("token123");
    });

    it("preserves non-sensitive data", () => {
      const context = {
        user_id: 123,
        name: "Test User",
        action: "login",
        timestamp: "2023-01-01"
      };
      logInfo("TEST_SERVICE", "Message", context);

      expect(logged(consoleInfoSpy)).toContain('"user_id":123');
      expect(logged(consoleInfoSpy)).toContain('"name":"Test User"');
    });
  });
});
