import { describe, it, expect } from "vitest";
import { bearerAssertionVerifier } from "../../../src/lib/auth/bearer-assertion";
import { PlatformContext } from "../../../src/lib/context";
import { base64UrlEncodeString, signAssertion } from "./assertion-helper";

const SECRET = "test-secret";

function platformWithSecret(secret: string | undefined): PlatformContext {
  return {
    getCache: () => {
      throw new Error("not implemented");
    },
    getEnv: (key: string) =>
      key === "ASSERTION_SIGNING_SECRET" ? secret : undefined,
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
