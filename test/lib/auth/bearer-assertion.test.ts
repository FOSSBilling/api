import { describe, it, expect } from "vitest";
import { bearerAssertionVerifier } from "../../../src/lib/auth/bearer-assertion";
import { PlatformContext } from "../../../src/lib/context";
import { base64UrlEncodeString, signAssertion } from "./assertion-helper";

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

  it.each(["iat", "exp"])(
    "rejects fractional %s NumericDate values",
    async (claim) => {
      const now = Math.floor(Date.now() / 1000);
      const overrides =
        claim === "iat"
          ? { iat: now + 0.5, exp: now + 60 }
          : { iat: now, exp: now + 59.5 };
      const token = await signAssertion(SECRET, {
        iat: overrides.iat,
        exp: overrides.exp
      });
      const principal = await bearerAssertionVerifier.verify(
        token,
        platformWithSecret(SECRET)
      );

      expect(principal).toBeNull();
    }
  );

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["overlong", 61]
  ])("rejects a token with a %s lifetime", async (_name, lifetime) => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signAssertion(SECRET, {
      iat: now,
      exp: now + lifetime
    });
    const principal = await bearerAssertionVerifier.verify(
      token,
      platformWithSecret(SECRET)
    );

    expect(principal).toBeNull();
  });

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

  it("rejects a legacy token without contextual claims", async () => {
    const token = await signAssertion(SECRET, {
      includeContext: false
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
