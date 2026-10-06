import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import app from "../../../../src/app";
import { Hono } from "hono";
import {
  previewGitHub,
  previewRequest
} from "../../../../src/services/previews/v1/github/request";

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
    await runInDurableObject(budget(), (instance) => {
      for (let i = 0; i < 12; i++)
        expect(instance.reserve("one-client")).toBe(true);
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

  it("caps each cold scan and leaves capacity for another client", async () => {
    vi.mocked(request).mockResolvedValue({
      data: {
        artifacts: Array.from({ length: 100 }, () => ({
          name: "other",
          expired: false
        }))
      }
    } as never);
    expect((await get("/previews/v1/commit/aaaaaaa")).status).toBe(503);
    expect(request).toHaveBeenCalledTimes(8);
    expect(await env.CACHE_KV.get("preview:commit:aaaaaaa")).toBeNull();
    expect((await get("/previews/v1/commit/bbbbbbb")).status).toBe(503);
    expect(request).toHaveBeenCalledTimes(12);
    expect(await env.CACHE_KV.get("preview:commit:bbbbbbb")).toBeNull();
    vi.mocked(request).mockResolvedValue({ data: { artifacts: [] } } as never);
    expect((await get("/previews/v1/commit/ccccccc", "192.0.2.2")).status).toBe(
      404
    );
    expect(request).toHaveBeenCalledTimes(13);
  });

  it("bounds full-SHA run scans without negative caching", async () => {
    const sha = "d".repeat(40);
    vi.mocked(request).mockImplementation(
      async (route) =>
        ({
          data:
            route === "GET /repos/{owner}/{repo}/actions/runs"
              ? {
                  workflow_runs: Array.from({ length: 100 }, (_, id) => ({
                    id,
                    head_sha: sha
                  }))
                }
              : { artifacts: [] }
        }) as never
    );
    expect((await get(`/previews/v1/commit/${sha}`)).status).toBe(503);
    expect(request).toHaveBeenCalledTimes(8);
    expect(await env.CACHE_KV.get(`preview:commit:${sha}`)).toBeNull();
  });

  it("shares the ceiling across PR head, artifact scan and redirect", async () => {
    const sha = "e".repeat(40);
    let listings = 0;
    vi.mocked(request).mockImplementation(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}")
        return { data: { head: { sha } } } as never;
      if (route === "GET /repos/{owner}/{repo}/actions/runs")
        return {
          data: {
            workflow_runs: Array.from({ length: 5 }, (_, id) => ({
              id,
              head_sha: sha
            }))
          }
        } as never;
      if (
        route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts" &&
        ++listings === 5
      )
        return {
          data: {
            artifacts: [
              {
                id: 123,
                name: "FOSSBilling-preview-build.zip",
                expired: false,
                size_in_bytes: 10
              }
            ]
          }
        } as never;
      return { data: { artifacts: [] } } as never;
    });
    expect((await get("/previews/v1/pr/9001/download")).status).toBe(503);
    expect(request).toHaveBeenCalledTimes(8);
    expect(request).not.toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
      expect.anything()
    );
  });

  it("clamps old persisted client balances to the new capacity", async () => {
    await runInDurableObject(budget(), (instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO buckets VALUES ('client:legacy', 60, ?)",
        Date.now()
      );
      for (let i = 0; i < 12; i++)
        expect(instance.reserve("legacy")).toBe(true);
      expect(instance.reserve("legacy")).toBe(false);
      expect(instance.reserve("new-client")).toBe(true);
    });
  });

  it.each([
    ["2001:db8:1234:5678::1", "2001:0DB8:1234:5678:abcd:0:0:2"],
    ["192.0.2.1", "::ffff:192.0.2.1"],
    ["::ffff:c000:201", "0:0:0:0:0:ffff:c000:201"],
    ["invalid", "also-invalid"]
  ])("shares a client allowance for %s and %s", async (first, second) => {
    vi.mocked(request).mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 })
    );
    for (let i = 1; i <= 12; i++)
      expect((await get(`/previews/v1/pr/${i}`, first)).status).toBe(404);
    expect((await get("/previews/v1/pr/13", second)).status).toBe(503);
    expect(request).toHaveBeenCalledTimes(12);
    expect(
      (await get("/previews/v1/pr/14", "2001:db8:1234:5679::1")).status
    ).toBe(404);
  });

  it("caps concurrent subrequests before awaiting reservations", async () => {
    const probe = new Hono<{ Bindings: CloudflareBindings }>();
    probe.get("/", async (c) => {
      const github = previewGitHub(c);
      const allowed = await Promise.all(
        Array.from({ length: 20 }, () => github.reserve())
      );
      return c.json(allowed.filter(Boolean).length);
    });
    const response = await probe.request(
      "/",
      { headers: { "CF-Connecting-IP": "192.0.2.1" } },
      env
    );
    expect(await response.json()).toBe(8);
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
