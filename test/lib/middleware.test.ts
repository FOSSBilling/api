import { describe, it, expect } from "vitest";
import { Context } from "hono";
import { getPlatform } from "../../src/lib/middleware";

// platformMiddleware's happy path is exercised end-to-end by every suite that
// boots the real app (test/integration, versions/v1); these tests would only
// re-prove Hono's middleware dispatch. The failure contract, however, is
// this module's own.
describe("getPlatform", () => {
  it("should throw error when platform context not found", () => {
    const mockHonoContext = {
      get: () => undefined
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
    } as unknown as Context<any, any, {}>;

    expect(() => getPlatform(mockHonoContext)).toThrow(
      "Platform context not found"
    );
  });
});
