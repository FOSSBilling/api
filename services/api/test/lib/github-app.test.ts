import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { githubTokenProvider } from "../../src/lib/github-app";

let privateKey: string;
let publicKey: CryptoKey;
let sequence = 0;
let settings: Record<string, string>;
const fetchMock = vi.fn<typeof fetch>();
const platform = { getEnv: (name: string) => settings[name] };

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const bytes = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer
  );
  privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----`;
});

beforeEach(() => {
  settings = {
    GITHUB_APP_CLIENT_ID: `test-client-${++sequence}`,
    GITHUB_APP_INSTALLATION_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey
  };
  fetchMock.mockReset().mockImplementation(async () =>
    Response.json({
      token: "installation-token",
      expires_at: new Date(Date.now() + 3600_000).toISOString()
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub App authentication", () => {
  it("lazily signs an App JWT and requests only the repository's read permissions", async () => {
    const getToken = githubTokenProvider(platform);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getToken()).toBe("installation-token");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/app/installations/123/access_tokens"
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      repositories: ["FOSSBilling"],
      permissions: { contents: "read", actions: "read", pull_requests: "read" }
    });
    const jwt = new Headers(init?.headers).get("authorization")!.slice(7);
    const [header, payload, signature] = jwt.split(".");
    const decode = (value: string) =>
      Uint8Array.from(
        atob(value.replace(/-/g, "+").replace(/_/g, "/")),
        (char) => char.charCodeAt(0)
      );
    expect(JSON.parse(new TextDecoder().decode(decode(payload)))).toMatchObject(
      {
        iss: settings.GITHUB_APP_CLIENT_ID
      }
    );
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        decode(signature),
        new TextEncoder().encode(`${header}.${payload}`)
      )
    ).toBe(true);
  });

  it("coalesces callers within a request and reuses resolved tokens across requests", async () => {
    const getToken = githubTokenProvider(platform);
    expect(await Promise.all([getToken(), getToken()])).toEqual([
      "installation-token",
      "installation-token"
    ]);
    expect(await githubTokenProvider(platform)()).toBe("installation-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes before expiry and invalidates the cache on key rotation", async () => {
    await githubTokenProvider(platform)();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3541_000);
    await githubTokenProvider(platform)();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Escaped-newline PEMs are accepted and a changed key value invalidates the cache.
    settings.GITHUB_APP_PRIVATE_KEY = privateKey.replace(/\n/g, "\\n");
    await githubTokenProvider(platform)();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed when credentials are missing", async () => {
    delete settings.GITHUB_APP_PRIVATE_KEY;
    await expect(githubTokenProvider(platform)()).rejects.toMatchObject({
      httpStatus: 503,
      message: "GitHub App credentials are not configured"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes token failures, preserves unavailable semantics and retries on a new request", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("sensitive upstream response", { status: 404 })
    );
    await expect(githubTokenProvider(platform)()).rejects.toMatchObject({
      httpStatus: 503,
      message: "GitHub App authentication is unavailable"
    });
    expect(await githubTokenProvider(platform)()).toBe("installation-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
