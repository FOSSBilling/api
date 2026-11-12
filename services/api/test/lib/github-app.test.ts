import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { githubClientProvider } from "../../src/lib/github-app";
import { checkGithubEntity } from "../../src/services/extensions/v2/github/verification";

let pkcs1: string;
let pkcs8: string;
let sequence = 0;
let settings: Record<string, string>;
const fetchMock = vi.fn<typeof fetch>();
const platform = { getEnv: (name: string) => settings[name] };
const tokenRequests = () =>
  fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith("/access_tokens")
  );

function generateTestKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  }).privateKey;
}

beforeAll(() => {
  pkcs1 = generateTestKey();
  pkcs8 = createPrivateKey(pkcs1)
    .export({ type: "pkcs8", format: "pem" })
    .toString();
});

beforeEach(() => {
  settings = {
    GITHUB_APP_CLIENT_ID: `test-client-${++sequence}`,
    GITHUB_APP_INSTALLATION_ID: "123",
    GITHUB_APP_PRIVATE_KEY: pkcs1
  };
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    if (String(url).endsWith("/access_tokens")) {
      const body = JSON.parse(init?.body as string);
      return Response.json({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: body.permissions,
        repository_selection: "selected"
      });
    }
    expect(new Headers(init?.headers).get("authorization")).toMatch(
      /^(?:token|bearer) installation-token$/i
    );
    return String(url).endsWith("/graphql")
      ? Response.json({ data: { repository: { name: "FOSSBilling" } } })
      : Response.json({ login: "FOSSBilling" });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub client", () => {
  it.each(["PKCS#1", "PKCS#8"])(
    "accepts %s PEMs and authenticates REST and GraphQL with restricted tokens",
    async (format) => {
      settings.GITHUB_APP_PRIVATE_KEY =
        format === "PKCS#1" ? pkcs1 : pkcs8.replace(/\n/g, "\\n");
      const getClient = githubClientProvider(platform);
      expect(fetchMock).not.toHaveBeenCalled();
      const github = await getClient();
      expect(
        (
          await github.request("GET /users/{username}", {
            username: "FOSSBilling"
          })
        ).data.login
      ).toBe("FOSSBilling");
      expect(
        await github.graphql(
          '{ repository(owner: "FOSSBilling", name: "FOSSBilling") { name } }'
        )
      ).toEqual({ repository: { name: "FOSSBilling" } });
      expect(tokenRequests()).toHaveLength(1);
      const [url, init] = tokenRequests()[0];
      expect(url).toBe(
        "https://api.github.com/app/installations/123/access_tokens"
      );
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({
        repositories: ["FOSSBilling"],
        permissions: {
          contents: "read",
          actions: "read",
          pull_requests: "read"
        }
      });
    }
  );

  it("reuses the request's client and Octokit's token cache until credentials change", async () => {
    const getClient = githubClientProvider(platform);
    const [first, second] = await Promise.all([getClient(), getClient()]);
    expect(second).toBe(first);
    await githubClientProvider(platform)();
    expect(tokenRequests()).toHaveLength(1);
    settings.GITHUB_APP_PRIVATE_KEY = generateTestKey();
    await githubClientProvider(platform)();
    expect(tokenRequests()).toHaveLength(2);
  });

  it("keeps a token-endpoint 404 unavailable during developer verification", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const result = await checkGithubEntity(
      "fossbilling",
      githubClientProvider(platform)
    );
    expect(result.status).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenRequests()).toHaveLength(1);
  });

  it("sanitizes token failures and permits a retry on the next request", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("sensitive upstream response", { status: 404 })
    );
    await expect(githubClientProvider(platform)()).rejects.toMatchObject({
      httpStatus: 503,
      message: "GitHub App authentication is unavailable"
    });
    await expect(githubClientProvider(platform)()).resolves.toHaveProperty(
      "request"
    );
    expect(tokenRequests()).toHaveLength(2);
  });
});
