import { verify as verifyJwt } from "hono/jwt";
import { logWarn } from "../logger";
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
  purpose: typeof ASSERTION_PURPOSE | "identity-sync";
  body_sha256?: string;
  ver: typeof ASSERTION_VERSION;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isAssertionPayload(
  value: unknown,
  purpose: AssertionPayload["purpose"]
): value is AssertionPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sub === "string" &&
    record.sub.length > 0 &&
    isInteger(record.iat) &&
    isInteger(record.exp) &&
    record.iss === ASSERTION_ISSUER &&
    record.aud === ASSERTION_AUDIENCE &&
    record.purpose === purpose &&
    (purpose !== "identity-sync" ||
      (typeof record.body_sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(record.body_sha256))) &&
    record.ver === ASSERTION_VERSION
  );
}

// Failed verifications are routine public traffic (expired 60s assertions,
// malformed tokens, junk Authorization headers), so an unthrottled warn is
// attacker-spammable log volume that drowns out the misconfiguration
// signal it exists to surface. At most one warn per isolate per minute.
const WARN_INTERVAL_MS = 60_000;
let lastAuthWarnAt = 0;

// Per-isolate memo of each secret's imported HMAC CryptoKey: hono's JWT
// verify re-imports the raw secret on every call otherwise. Holds at most
// the two configured rotation secrets.
const importedKeys = new Map<string, Promise<CryptoKey>>();

function importedKeyFor(secret: string): Promise<CryptoKey> {
  let key = importedKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    importedKeys.set(secret, key);
  }
  return key;
}

// Verifies the Extensions site's compact HS256 assertion
// (header.payload.signature). Hono performs JWT parsing and signature
// verification with the algorithm pinned by ASSERTION_VERIFY_OPTIONS; the
// checks below are specific to this assertion profile.
function assertionVerifier(
  purpose: AssertionPayload["purpose"]
): TokenVerifier {
  return {
    async verify(token, platform): Promise<AuthPrincipal | null> {
      const secrets = [
        platform.getEnv("ASSERTION_SIGNING_SECRET"),
        platform.getEnv("ASSERTION_SIGNING_SECRET_PREVIOUS")
      ].filter((secret): secret is string => Boolean(secret));
      if (secrets.length === 0) return null;

      for (const secret of secrets) {
        let payload: unknown;
        try {
          payload = await verifyJwt(
            token,
            await importedKeyFor(secret),
            ASSERTION_VERIFY_OPTIONS
          );
        } catch {
          continue;
        }
        if (!isAssertionPayload(payload, purpose)) continue;

        const now = Math.floor(Date.now() / 1000);
        if (payload.iat > now + CLOCK_SKEW_SECONDS) continue;
        if (payload.exp <= payload.iat) continue;
        if (payload.exp - payload.iat > ASSERTION_TTL_SECONDS) continue;

        if (purpose === "identity-sync") {
          // isAssertionPayload() verified body_sha256 above; re-check here
          // so the type narrows without a non-null assertion.
          const bodySha256 = payload.body_sha256;
          if (typeof bodySha256 !== "string") continue;
          return { userId: payload.sub, scope: "identity_sync", bodySha256 };
        }
        return { userId: payload.sub, scope: "assertion" };
      }

      // A consistent failure across every configured secret is the only
      // signal a misconfigured ASSERTION_SIGNING_SECRET produces.
      const now = Date.now();
      if (now - lastAuthWarnAt >= WARN_INTERVAL_MS) {
        lastAuthWarnAt = now;
        logWarn("auth", "Bearer assertion failed verification", {
          secretsTried: secrets.length
        });
      }
      return null;
    }
  };
}

export const bearerAssertionVerifier = assertionVerifier(ASSERTION_PURPOSE);
// Service proofs are not registered in the general bearer verifier list.
export const identitySyncAssertionVerifier = assertionVerifier("identity-sync");
