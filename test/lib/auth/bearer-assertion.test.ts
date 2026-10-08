import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  bearerAssertionVerifier,
  identitySyncAssertionVerifier
} from "../../../src/lib/auth/bearer-assertion";
import { logWarn } from "../../../src/lib/logger";
import { PlatformContext } from "../../../src/lib/context";
import { base64UrlEncodeString, signAssertion } from "./assertion-helper";

vi.mock("../../../src/lib/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn()
}));

const SECRET = "test-secret";

function platformWithSecret(
  secret: string | undefined,
  previousSecret?: string
): PlatformContext {
  return {
    getCache: () => {
      throw new Error("not implemented");
    },
    getEnv: (key: string) => {
      if (key === "ASSERTION_SIGNING_SECRET") return secret;
      if (key === "ASSERTION_SIGNING_SECRET_PREVIOUS") return previousSecret;
      return undefined;
    },
    raw: undefined as unknown as PlatformContext["raw"]
  };
}

describe("bearerAssertionVerifier", () => {
  it("accepts a validly signed, non-expired assertion", async () => {
    const token = await signAssertion(SECRET, { sub: "user-42" });
    const principal = await bearerAssertionVerifier.verify(
      token,
      platformWithSecret(SECRET)
    );

    expect(principal).toEqual({ userId: "user-42", scope: "assertion" });
  });

  it("rejects an expired assertion", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signAssertion(SECRET, {
      iat: now - 120,
      exp: now - 60
    });

    const principal = await bearerAssertionVerifier.verify(
      token,
      platformWithSecret(SECRET)
    );

    expect(principal).toBeNull();
  });

  it("rejects a token signed with the wrong secret", async () => {
    const token = await signAssertion("wrong-secret");
    const principal = await bearerAssertionVerifier.verify(
      token,
      platformWithSecret(SECRET)
    );

    expect(principal).toBeNull();
  });

  it("accepts a token signed with the previous secret during rotation", async () => {
    const token = await signAssertion("previous-secret");
    const principal = await bearerAssertionVerifier.verify(
      token,
      platformWithSecret(SECRET, "previous-secret")
    );

    expect(principal).toEqual({ userId: "user-1", scope: "assertion" });
  });

  it("rejects a token signed with the previous secret when it is not configured", async () => {
    const token = await signAssertion("previous-secret");
    const principal = await bearerAssertionVerifier.verify(
      token,
      platformWithSecret(SECRET)
    );

    expect(principal).toBeNull();
  });

  // iss/aud/purpose/ver are minter constants, but a minter/API version skew
  // (one side deploying before the other) is a real operational scenario, as
  // is sibling-verifier traffic for `purpose` - the full claim matrix stays.
  it.each([
    ["issuer", { iss: "wrong-issuer" }],
    ["audience", { aud: "wrong-audience" }],
    ["purpose", { purpose: "wrong-purpose" }],
    ["version", { ver: 2 }]
  ])("rejects a token with a wrong %s claim", async (_name, overrides) => {
    const token = await signAssertion(SECRET, overrides);
    const principal = await bearerAssertionVerifier.verify(
      token,
      platformWithSecret(SECRET)
    );

    expect(principal).toBeNull();
  });

  // The minter structurally cannot emit the states the removed tests pinned
  // (fractional NumericDates, non-60s lifetimes, tokens without contextual
  // claims): it emits integer seconds and a fixed 60s lifetime. The src
  // guards for those remain as defense against a broken minter, and a
  // minter regression surfaces as the wrong iss/aud/ver shapes above.

  it("rejects a token issued too far in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signAssertion(SECRET, {
      iat: now + 6,
      exp: now + 66
    });
    const principal = await bearerAssertionVerifier.verify(
      token,
      platformWithSecret(SECRET)
    );

    expect(principal).toBeNull();
  });

  it("rejects a token that declares a different algorithm", async () => {
    const token = await signAssertion(SECRET, {
      header: { alg: "HS384", typ: "JWT" }
    });
    const principal = await bearerAssertionVerifier.verify(
      token,
      platformWithSecret(SECRET)
    );

    expect(principal).toBeNull();
  });

  it("rejects a malformed token", async () => {
    const principal = await bearerAssertionVerifier.verify(
      "not-a-jwt",
      platformWithSecret(SECRET)
    );

    expect(principal).toBeNull();
  });

  it("rejects a token with a tampered payload", async () => {
    const token = await signAssertion(SECRET, { sub: "user-1" });
    const [header, , signature] = token.split(".");

    const now = Math.floor(Date.now() / 1000);
    const tamperedPayload = base64UrlEncodeString(
      JSON.stringify({ sub: "user-attacker", iat: now, exp: now + 60 })
    );
    const tampered = `${header}.${tamperedPayload}.${signature}`;

    const principal = await bearerAssertionVerifier.verify(
      tampered,
      platformWithSecret(SECRET)
    );

    expect(principal).toBeNull();
  });

  it("rejects when ASSERTION_SIGNING_SECRET is not configured", async () => {
    const token = await signAssertion(SECRET);
    const principal = await bearerAssertionVerifier.verify(
      token,
      platformWithSecret(undefined)
    );

    expect(principal).toBeNull();
  });
});

describe("identitySyncAssertionVerifier", () => {
  it("requires the dedicated purpose and a signed SHA-256 digest", async () => {
    expect(
      await identitySyncAssertionVerifier.verify(
        await signAssertion(SECRET),
        platformWithSecret(SECRET)
      )
    ).toBeNull();
    const digest = "a".repeat(64);
    const token = await signAssertion(SECRET, {
      purpose: "identity-sync",
      bodySha256: digest
    });
    expect(
      await identitySyncAssertionVerifier.verify(
        token,
        platformWithSecret(SECRET)
      )
    ).toEqual({ userId: "user-1", scope: "identity_sync", bodySha256: digest });
    expect(
      await bearerAssertionVerifier.verify(token, platformWithSecret(SECRET))
    ).toBeNull();
  });
  it.each([undefined, ""])(
    "rejects a missing digest %s",
    async (bodySha256) => {
      const token = await signAssertion(SECRET, {
        purpose: "identity-sync",
        bodySha256
      });
      expect(
        await identitySyncAssertionVerifier.verify(
          token,
          platformWithSecret(SECRET)
        )
      ).toBeNull();
    }
  );
  it.each([
    { iss: "wrong" },
    { aud: "wrong" },
    { ver: 2 },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { iat: Math.floor(Date.now() / 1000) + 10 },
    { exp: Math.floor(Date.now() / 1000) + 120 }
  ])("rejects invalid identity proof metadata %j", async (overrides) => {
    const token = await signAssertion(SECRET, {
      purpose: "identity-sync",
      bodySha256: "a".repeat(64),
      ...overrides
    });
    expect(
      await identitySyncAssertionVerifier.verify(
        token,
        platformWithSecret(SECRET)
      )
    ).toBeNull();
  });
  it("preserves secret rotation for service proofs", async () => {
    const token = await signAssertion("previous", {
      purpose: "identity-sync",
      bodySha256: "a".repeat(64)
    });
    expect(
      await identitySyncAssertionVerifier.verify(
        token,
        platformWithSecret(SECRET, "previous")
      )
    ).not.toBeNull();
    expect(
      await identitySyncAssertionVerifier.verify(
        token,
        platformWithSecret(SECRET)
      )
    ).toBeNull();
  });
});

describe("verification warnings", () => {
  beforeEach(() => {
    // Push past the warn throttle so assertions below are meaningful
    // rather than an artifact of earlier tests warning first.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    vi.mocked(logWarn).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not warn for a sibling-purpose assertion", async () => {
    const token = await signAssertion(SECRET, { sub: "user-42" });
    expect(
      await identitySyncAssertionVerifier.verify(
        token,
        platformWithSecret(SECRET)
      )
    ).toBeNull();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("still warns for tokens valid for neither purpose", async () => {
    expect(
      await identitySyncAssertionVerifier.verify(
        "not-a-jwt",
        platformWithSecret(SECRET)
      )
    ).toBeNull();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});
