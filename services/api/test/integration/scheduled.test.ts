import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
const mocks = vi.hoisted(() => ({
  recover: vi.fn(),
  maintain: vi.fn(),
  report: vi.fn()
}));
vi.mock("../../src/lib/adapters/cloudflare/packaging-jobs", () => ({
  consumePackagingJobs: vi.fn(),
  recoverPackagingJobs: mocks.recover
}));
vi.mock("../../src/services/extensions/v2/db/resource-maintenance", () => ({
  maintainExtensionResources: mocks.maintain,
  reportExtensionResources: mocks.report
}));
import app from "../../src/app/index";
afterEach(() => vi.restoreAllMocks());
describe("scheduled maintenance", () => {
  it("continues resource maintenance when package recovery fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.recover.mockRejectedValueOnce(new Error("job database unavailable"));
    mocks.maintain.mockResolvedValueOnce(undefined);
    mocks.report.mockResolvedValueOnce(undefined);
    await app.scheduled({} as ScheduledController, env);
    expect(mocks.maintain).toHaveBeenCalledOnce();
    expect(mocks.report).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { error: "job database unavailable" }
      })
    );
  });
});
