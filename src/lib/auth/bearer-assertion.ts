import { verify as verifyJwt } from "hono/jwt";
import { AuthPrincipal, TokenVerifier } from "./interfaces";

const CLOCK_SKEW_SECONDS = 5;
const ASSERTION_TTL_SECONDS = 60;
const ASSERTION_ISSUER = "fossbilling-extensions";
const ASSERTION_AUDIENCE = "fossbilling-api/extensions-v2";
const ASSERTION_PURPOSE = "user-authentication";
const ASSERTION_VERSION = 1;

const ASSERTION_VERIFY_OPTIONS = {
  alg: "HS256",
  aud: ASSERTION_AUDIENCE,
  exp: true,
  iat: false,
  iss: ASSERTION_ISSUER
} as const;

interface AssertionPayload {
  sub: string;
  iat: number;
  exp: number;
  iss: typeof ASSERTION_ISSUER;
  aud: typeof ASSERTION_AUDIENCE;
  purpose: typeof ASSERTION_PURPOSE;
  ver: typeof ASSERTION_VERSION;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isAssertionPayload(value: unknown): value is AssertionPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sub === "string" &&
    record.sub.length > 0 &&
    isInteger(record.iat) &&
    isInteger(record.exp) &&
    record.iss === ASSERTION_ISSUER &&
    record.aud === ASSERTION_AUDIENCE &&
    record.purpose === ASSERTION_PURPOSE &&
    record.ver === ASSERTION_VERSION
  );
}

// Verifies the Extensions site's compact HS256 assertion
// (header.payload.signature). Hono performs JWT parsing and signature
// verification with the algorithm pinned by ASSERTION_VERIFY_OPTIONS; the
// checks below are specific to this assertion profile.
export const bearerAssertionVerifier: TokenVerifier = {
  async verify(token, platform): Promise<AuthPrincipal | null> {
    const secrets = [
      platform.getEnv("ASSERTION_SIGNING_SECRET"),
      platform.getEnv("ASSERTION_SIGNING_SECRET_PREVIOUS")
    ].filter((secret): secret is string => Boolean(secret));
    if (secrets.length === 0) return null;

    for (const secret of secrets) {
      let payload: unknown;
      try {
        payload = await verifyJwt(token, secret, ASSERTION_VERIFY_OPTIONS);
      } catch {
        continue;
      }
      if (!isAssertionPayload(payload)) continue;

      const now = Math.floor(Date.now() / 1000);
      if (payload.iat > now + CLOCK_SKEW_SECONDS) continue;
      if (payload.exp <= payload.iat) continue;
      if (payload.exp - payload.iat > ASSERTION_TTL_SECONDS) continue;

      return { userId: payload.sub, scope: "assertion" };
    }

    return null;
  }
};
