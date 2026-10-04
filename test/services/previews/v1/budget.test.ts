import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import app from "../../../../src/app";
import { previewRequest } from "../../../../src/services/previews/v1/github/request";

vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);
import { request } from "@octokit/request";

const budget = () => env.PREVIEW_GITHUB_BUDGET.getByName("previews");

async function get(path: string, ip = "192.0.2.1") {
  const ctx = createExecutionContext();
  const response = await app.request(
    path,
    { headers: { "CF-Connecting-IP": ip } },
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await runInDurableObject(budget(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM buckets");
  });
  const keys = await env.CACHE_KV.list({ prefix: "preview:" });
  await Promise.all(keys.keys.map(({ name }) => env.CACHE_KV.delete(name)));
});

describe("preview GitHub budget", () => {
  it("atomically caps concurrent reservations across distinct clients", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => budget().reserve(`client-${i}`))
    );
    expect(results.filter(Boolean)).toHaveLength(60);
    expect(await budget().reserve("another-client")).toBe(false);
  });

  it("enforces the client bucket even when global capacity remains", async () => {
    await runInDurableObject(budget(), (instance, state) => {
      for (let i = 0; i < 60; i++)
        expect(instance.reserve("one-client")).toBe(true);
      state.storage.sql.exec("DELETE FROM buckets WHERE key = 'global'");
      expect(instance.reserve("one-client")).toBe(false);
      expect(instance.reserve("other-client")).toBe(true);
    });
  });

  it("refills persisted buckets and expires idle client state", async () => {
    await runInDurableObject(budget(), (instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        "INSERT INTO buckets VALUES ('global', 0, ?)",
        now - 36000
      );
      state.storage.sql.exec(
        "INSERT INTO buckets VALUES ('client:active', 0, ?)",
        now - 36000
      );
      state.storage.sql.exec(
        "INSERT INTO buckets VALUES ('client:idle', 0, ?)",
        now - 1800001
      );
      expect(instance.reserve("active")).toBe(true);
      expect(instance.reserve("active")).toBe(false);
      expect(
        state.storage.sql
          .exec("SELECT * FROM buckets WHERE key = 'client:idle'")
          .toArray()
      ).toHaveLength(0);
    });
  });

  it("bounds distinct short SHA misses including every fallback page", async () => {
    vi.mocked(request).mockResolvedValue({
      data: {
        artifacts: Array.from({ length: 100 }, () => ({
          name: "other",
          expired: false
        }))
      }
    } as never);
    expect((await get("/previews/v1/commit/aaaaaaa")).status).toBe(404);
    expect(request).toHaveBeenCalledTimes(51);
    expect((await get("/previews/v1/commit/bbbbbbb", "192.0.2.2")).status).toBe(
      503
    );
    expect(request).toHaveBeenCalledTimes(60);
    expect(await env.CACHE_KV.get("preview:commit:bbbbbbb")).toBeNull();
    expect((await get("/previews/v1/commit/ccccccc", "192.0.2.3")).status).toBe(
      503
    );
    expect(request).toHaveBeenCalledTimes(60);
  });

  it("bounds distinct PR keys before contacting GitHub", async () => {
    vi.mocked(request).mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 })
    );
    for (let i = 1; i <= 60; i++) {
      expect((await get(`/previews/v1/pr/${i}`, `192.0.2.${i}`)).status).toBe(
        404
      );
    }
    expect((await get("/previews/v1/pr/61")).status).toBe(503);
    expect(request).toHaveBeenCalledTimes(60);
    expect(await env.CACHE_KV.get("preview:pr:61")).toBeNull();
  });

  it("serves cached metadata but denies live downloads when exhausted", async () => {
    const sha = "a".repeat(40);
    await env.CACHE_KV.put(
      `preview:commit:${sha}`,
      JSON.stringify({ commit_sha: sha, artifact_id: 123 })
    );
    for (let i = 0; i < 60; i++) await budget().reserve(`client-${i}`);
    expect((await get(`/previews/v1/commit/${sha}`)).status).toBe(200);
    expect((await get(`/previews/v1/commit/${sha}/download`)).status).toBe(503);
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed if reservation fails", async () => {
    await expect(
      previewRequest(
        {
          token: "test",
          reserve: async () => {
            throw new Error("budget unavailable");
          }
        },
        "GET /repos/{owner}/{repo}/actions/artifacts",
        {}
      )
    ).rejects.toThrow("Preview GitHub budget unavailable");
    expect(request).not.toHaveBeenCalled();
  });
});
