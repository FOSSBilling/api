import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  post,
  get,
  put,
  sampleContent,
  sampleCreate,
  seedDeveloper
} from "./harness";
import {
  insertUser,
  insertDeveloper,
  insertPublisherClient,
  getRevision
} from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

const JWKS_URL = "https://auth.fossbilling.net/.well-known/jwks.json";
const ISSUER = "https://auth.fossbilling.net";
const AUDIENCE = "https://api.fossbilling.net";
const KID = "test-key-1";
const CLIENT_ID = "modules-publisher";
const BOT_USER = "bot-user";
const DEVELOPER_ID = "fossbilling";

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlEncodeString(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;
let jwksKeys: Record<string, unknown>[] = [];

async function signMachineJwt(
  claims: Record<string, unknown>,
  kid: string = KID,
  key: CryptoKey = privateKey
): Promise<string> {
  const header = base64UrlEncodeString(
    JSON.stringify({ alg: "EdDSA", typ: "JWT", kid })
  );
  const payload = base64UrlEncodeString(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

function machineClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: CLIENT_ID,
    scope: "extensions:push extensions:publish",
    iat: now - 10,
    exp: now + 600,
    jti: crypto.randomUUID(),
    ...overrides
  };
}

async function machineHeaders(
  claims: Record<string, unknown> = {},
  kid: string = KID,
  key: CryptoKey = privateKey
): Promise<Record<string, string>> {
  const token = await signMachineJwt(machineClaims(claims), kid, key);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

async function seedPublisher(
  overrides: { canPublish?: number; revoked?: boolean } = {}
): Promise<void> {
  await insertUser(db, { id: BOT_USER });
  await insertDeveloper(db, {
    id: DEVELOPER_ID,
    type: "organization",
    name: "FOSSBilling",
    owner_user_id: BOT_USER,
    approved_at: "2026-01-01T00:00:00.000Z"
  });
  await insertPublisherClient(db, {
    client_id: CLIENT_ID,
    developer_id: DEVELOPER_ID,
    service_user_id: BOT_USER,
    can_publish: overrides.canPublish ?? 1,
    revoked_at: overrides.revoked ? "2026-01-01T00:00:00.000Z" : null
  });
}

beforeEach(async () => {
  // One keypair per file: the verifier caches the JWKS per isolate, so
  // rotating keys per test would verify new tokens against stale keys.
  if (!privateKey) {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify"
    ])) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicJwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.publicKey
    )) as unknown as Record<string, unknown>;
    jwksKeys = [{ ...publicJwk, kid: KID, alg: "EdDSA" }];
  }
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (async (input: unknown, init?: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url === JWKS_URL) {
      return new Response(JSON.stringify({ keys: jwksKeys }), {
        headers: { "content-type": "application/json" }
      });
    }
    return realFetch(input as RequestInfo, init as RequestInit);
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("machine publishing", () => {
  it("publishes a new extension end to end with machine credentials", async () => {
    await seedPublisher();

    const missing = await get(
      "/extensions/v2/extensions/branding",
      await machineHeaders()
    );
    expect(missing.status).toBe(404);

    const created = await post(
      "/extensions/v2/extensions",
      await machineHeaders(),
      sampleCreate({ extensionId: "branding" })
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      result: { id: string; revision_id: string; status: string };
    };
    expect(createdBody.result.id).toBe("branding");

    const approved = await post(
      `/extensions/v2/extensions/branding/revisions/${createdBody.result.revision_id}/approve?notify=false`,
      await machineHeaders(),
      {}
    );
    expect(approved.status).toBe(200);

    const detail = await get(
      "/extensions/v2/extensions/branding",
      await machineHeaders()
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      result: { id: string; published: { version: string } | null };
    };
    // The service user owns the extension, so it sees the owned view with
    // the published projection nested under `published`.
    expect(detailBody.result.published?.version).toBe("1.0.0");

    const revision = await getRevision(db, createdBody.result.revision_id);
    expect(revision?.submitted_by).toBe(BOT_USER);
    expect(revision?.reviewer_id).toBe(BOT_USER);
    expect(revision?.review_note).toBe("[auto policy=trusted-publisher]");
  });

  it("publishes an update to an existing extension", async () => {
    await seedPublisher();

    const created = await post(
      "/extensions/v2/extensions",
      await machineHeaders(),
      sampleCreate({ extensionId: "branding" })
    );
    expect(created.status).toBe(201);
    const firstRevision = (
      (await created.json()) as { result: { revision_id: string } }
    ).result.revision_id;
    const firstApprove = await post(
      `/extensions/v2/extensions/branding/revisions/${firstRevision}/approve?notify=false`,
      await machineHeaders(),
      {}
    );
    expect(firstApprove.status).toBe(200);

    const updated = await put(
      "/extensions/v2/extensions/branding",
      await machineHeaders(),
      { ...sampleContent(), version: "1.1.0" }
    );
    expect(updated.status).toBe(202);
    const secondRevision = (
      (await updated.json()) as { result: { revision_id: string } }
    ).result.revision_id;

    const secondApprove = await post(
      `/extensions/v2/extensions/branding/revisions/${secondRevision}/approve?notify=false`,
      await machineHeaders(),
      {}
    );
    expect(secondApprove.status).toBe(200);

    const detail = await get(
      "/extensions/v2/extensions/branding",
      await machineHeaders()
    );
    expect(detail.status).toBe(200);
    expect(
      (
        (await detail.json()) as {
          result: { published: { version: string } | null };
        }
      ).result.published?.version
    ).toBe("1.1.0");
  });

  it("rejects unknown publisher clients", async () => {
    await seedPublisher();
    const headers = await machineHeaders({ sub: "someone-else" });
    const res = await get("/extensions/v2/extensions/branding", headers);
    expect(res.status).toBe(401);
    const created = await post(
      "/extensions/v2/extensions",
      headers,
      sampleCreate({ extensionId: "branding" })
    );
    expect(created.status).toBe(401);
  });

  it("rejects revoked clients", async () => {
    await seedPublisher({ revoked: true });
    const res = await post(
      "/extensions/v2/extensions",
      await machineHeaders(),
      sampleCreate({ extensionId: "branding" })
    );
    expect(res.status).toBe(401);
  });

  it("rejects expired tokens, wrong audience, and tampered payloads", async () => {
    await seedPublisher();
    const now = Math.floor(Date.now() / 1000);

    const expired = await post(
      "/extensions/v2/extensions",
      await machineHeaders({ exp: now - 60 }),
      sampleCreate({ extensionId: "branding" })
    );
    expect(expired.status).toBe(401);

    const wrongAud = await post(
      "/extensions/v2/extensions",
      await machineHeaders({ aud: "https://evil.example.com" }),
      sampleCreate({ extensionId: "branding" })
    );
    expect(wrongAud.status).toBe(401);

    const valid = await signMachineJwt(machineClaims());
    const [header, payload, signature] = valid.split(".");
    const tamperedPayload = `A${payload.slice(1)}`;
    const tampered = await get("/extensions/v2/extensions/branding", {
      Authorization: `Bearer ${header}.${tamperedPayload}.${signature}`,
      "Content-Type": "application/json"
    });
    expect(tampered.status).toBe(401);
  });

  it("recovers from issuer key rotation without waiting out the cache", async () => {
    await seedPublisher();
    // Prime the JWKS cache with the original key set.
    const before = await get(
      "/extensions/v2/extensions/branding",
      await machineHeaders()
    );
    expect(before.status).toBe(404);

    // Issuer rotates: the cached set no longer contains the new kid, so the
    // verifier must refresh once instead of failing.
    const rotated = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const rotatedJwk = (await crypto.subtle.exportKey(
      "jwk",
      rotated.publicKey
    )) as unknown as Record<string, unknown>;
    const previousKeys = jwksKeys;
    try {
      jwksKeys = [{ ...rotatedJwk, kid: "test-key-2", alg: "EdDSA" }];
      const created = await post(
        "/extensions/v2/extensions",
        await machineHeaders({}, "test-key-2", rotated.privateKey),
        sampleCreate({ extensionId: "branding" })
      );
      expect(created.status).toBe(201);
    } finally {
      jwksKeys = previousKeys;
    }
  });

  it("lets push-only clients propose but not approve", async () => {
    await seedPublisher({ canPublish: 0 });

    const created = await post(
      "/extensions/v2/extensions",
      await machineHeaders({ scope: "extensions:push" }),
      sampleCreate({ extensionId: "branding" })
    );
    expect(created.status).toBe(201);
    const { revision_id } = (
      (await created.json()) as { result: { revision_id: string } }
    ).result;

    const approved = await post(
      `/extensions/v2/extensions/branding/revisions/${revision_id}/approve?notify=false`,
      await machineHeaders({
        scope: "extensions:push extensions:publish"
      }),
      {}
    );
    expect(approved.status).toBe(403);
  });

  it("rejects machine tokens without the push scope on owner writes", async () => {
    await seedPublisher();
    const res = await post(
      "/extensions/v2/extensions",
      await machineHeaders({ scope: "extensions:publish" }),
      sampleCreate({ extensionId: "branding" })
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "FORBIDDEN"
    );
  });

  it("rejects machine credentials on identity sync", async () => {
    await seedPublisher();
    const body = {
      name: "Bot",
      email: null,
      email_verified: false,
      picture: null,
      github_login: null,
      github_orgs: null,
      github_orgs_expires_at: null
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(body))
    );
    const bodySha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const token = await signMachineJwt(
      machineClaims({ body_sha256: bodySha256 })
    );
    const res = await put(
      "/extensions/v2/users/me/identity",
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body
    );
    // Identity sync only accepts its dedicated assertion type: the machine
    // token fails bearer verification before the scope check runs.
    expect(res.status).toBe(401);
  });

  it("still accepts human assertions alongside machine tokens", async () => {
    await seedPublisher();
    await seedDeveloper("dev-developer", "owner-1");
    const created = await post(
      "/extensions/v2/extensions",
      await authHeaders("owner-1"),
      sampleCreate({ extensionId: "human-ext" })
    );
    expect(created.status).toBe(201);
  });
});
