import { describe, it, expect, afterEach } from "vitest";
import type { PlatformContext } from "../../../src/lib/context";
import { m2mBearerVerifier } from "../../../src/lib/auth/m2m-bearer";
import {
  signAccessToken,
  activateM2mJwks,
  deactivateM2mJwks
} from "./m2m-helper";

// The verifier reads its configuration from the request's platform env; the
// fake platform doubles for the M2M_* bindings configured in vitest.config.ts.
const platform = {
  getEnv: (key: string) =>
    ({
      M2M_ISSUER: "https://auth.example.test",
      M2M_JWKS_URL: "https://auth.example.test/.well-known/jwks.json",
      M2M_AUDIENCE: "https://api.fossbilling.net"
    })[key]
} as unknown as PlatformContext;

const emptyPlatform = {
  getEnv: () => undefined
} as unknown as PlatformContext;

const verifier = m2mBearerVerifier;

afterEach(() => {
  deactivateM2mJwks();
});

describe("m2m bearer verifier", () => {
  it("verifies a resource-bound access token into a machine principal", async () => {
    await activateM2mJwks();
    const token = await signAccessToken({
      clientId: "modules-publisher",
      scopes: ["extensions:push", "extensions:publish"]
    });
    const principal = await verifier.verify(token, platform);
    expect(principal).toEqual({
      scope: "m2m",
      clientId: "modules-publisher",
      scopes: ["extensions:push", "extensions:publish"],
      userId: "m2m:modules-publisher"
    });
  });

  it("rejects a token naming a different audience", async () => {
    await activateM2mJwks();
    const token = await signAccessToken({
      aud: "https://other-api.example.test"
    });
    expect(await verifier.verify(token, platform)).toBeNull();
  });

  it("rejects a token from a different issuer", async () => {
    await activateM2mJwks();
    const token = await signAccessToken({ iss: "https://evil.example.test" });
    expect(await verifier.verify(token, platform)).toBeNull();
  });

  it("rejects an expired token", async () => {
    await activateM2mJwks();
    const token = await signAccessToken({
      exp: Math.floor(Date.now() / 1000) - 60
    });
    expect(await verifier.verify(token, platform)).toBeNull();
  });

  it("rejects a token with the wrong typ (user assertions are not machine tokens)", async () => {
    await activateM2mJwks();
    const token = await signAccessToken({ typ: "JWT" });
    expect(await verifier.verify(token, platform)).toBeNull();
  });

  it("rejects opaque tokens", async () => {
    expect(await verifier.verify("fba_at_not-a-jwt", platform)).toBeNull();
  });

  it("rejects a sub that does not mirror the client id", async () => {
    await activateM2mJwks();
    const token = await signAccessToken({
      clientId: "modules-publisher",
      sub: "someone-else"
    });
    expect(await verifier.verify(token, platform)).toBeNull();
  });

  it("rejects a token with no usable scope", async () => {
    await activateM2mJwks();
    const token = await signAccessToken({ scopes: [] });
    expect(await verifier.verify(token, platform)).toBeNull();
  });

  it("fails closed without configuration", async () => {
    await activateM2mJwks();
    const token = await signAccessToken();
    expect(await verifier.verify(token, emptyPlatform)).toBeNull();
  });
});
