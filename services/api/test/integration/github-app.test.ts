import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { request } from "@octokit/request";
import app from "../../src/app/index";
import { githubTokenProvider } from "../../src/lib/github-app";
import { checkGithubEntity } from "../../src/services/extensions/v2/github/verification";
import { isolateEdgeCache } from "../utils/isolate-edge-cache";
import { suppressConsole } from "../utils/mock-helpers";

vi.mock("@octokit/request", async () =>
  (await import("../mocks/octokit")).octokitRequestMock()
);

const bindings = {
  ...env,
  GITHUB_APP_CLIENT_ID: "",
  GITHUB_APP_INSTALLATION_ID: "",
  GITHUB_APP_PRIVATE_KEY: ""
};
const resetEdgeCache = isolateEdgeCache();
let restoreConsole: () => void;

beforeEach(async () => {
  restoreConsole = suppressConsole();
  vi.clearAllMocks();
  resetEdgeCache();
  await env.CACHE_KV.delete("gh-fossbilling-releases");
});
afterEach(() => restoreConsole());

async function releases() {
  const ctx = createExecutionContext();
  const response = await app.request("/versions/v1", {}, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

it("serves the release cache even when App credentials are unavailable", async () => {
  await env.CACHE_KV.put(
    "gh-fossbilling-releases",
    JSON.stringify({
      "1.0.0": {
        version: "1.0.0",
        released_on: "2026-01-01T00:00:00Z",
        minimum_php_version: "8.3",
        download_url: "https://example.com/release.zip",
        size_bytes: 100,
        is_prerelease: false,
        github_release_id: 1,
        changelog: "Release notes",
        mirror_download_url: null,
        mirror_digest: null
      }
    })
  );
  const response = await releases();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    result: { "1.0.0": { version: "1.0.0" } }
  });
  expect(request).not.toHaveBeenCalled();
});

it("returns unavailable on an uncached release lookup without App credentials", async () => {
  const response = await releases();
  expect(response.status).toBe(503);
  expect(request).not.toHaveBeenCalled();
});

it("does not turn an authentication outage into a missing developer", async () => {
  const result = await checkGithubEntity(
    "fossbilling",
    githubTokenProvider({
      getEnv: () => undefined
    })
  );
  expect(result.status).toBe("unavailable");
  expect(request).not.toHaveBeenCalled();
});
