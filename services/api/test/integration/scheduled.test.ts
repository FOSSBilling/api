import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
const mocks = vi.hoisted(() => ({
  recover: vi.fn(),
  maintain: vi.fn(),
  report: vi.fn()
}));
vi.mock("../../src/lib/adapters/cloudflare/package-dispatcher", () => ({
  packageDispatcher: () => ({ wake: mocks.recover })
}));
vi.mock("../../src/services/extensions/v2/db/resource-maintenance", () => ({
  maintainExtensionResources: mocks.maintain,
  reportExtensionResources: mocks.report
}));
import app from "../../src/app/index";
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
describe("scheduled maintenance", () => {
  it("reports a failed recovery wakeup after running resource maintenance", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("dispatcher unavailable");
    mocks.recover.mockRejectedValueOnce(error);
    mocks.maintain.mockResolvedValueOnce(undefined);
    mocks.report.mockResolvedValueOnce(undefined);
    await expect(
      app.scheduled(
        {} as ScheduledController,
        Object.assign({}, env, { EXTENSION_PACKAGES_MODE: "enabled" })
      )
    ).rejects.toBe(error);
    expect(mocks.maintain).toHaveBeenCalledOnce();
    expect(mocks.report).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { error: "dispatcher unavailable" }
      })
    );
  });

  it.each(["disabled", "local"])(
    "runs production maintenance without waking the dispatcher in %s mode",
    async (mode) => {
      await app.scheduled(
        {} as ScheduledController,
        Object.assign({}, env, {
          ENVIRONMENT: "production",
          EXTENSION_PACKAGES_MODE: mode
        })
      );
      expect(mocks.recover).not.toHaveBeenCalled();
      expect(mocks.maintain).toHaveBeenCalledOnce();
      expect(mocks.report).toHaveBeenCalledOnce();
    }
  );
});
