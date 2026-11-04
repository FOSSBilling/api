import { AuthPrincipal, TokenVerifier } from "../../../lib/auth";
import type { PlatformContext } from "../../../lib/context";
import { getExtensionsDb } from "../../../lib/db";
import { logWarn } from "../../../lib/logger";
import { PublisherClientsDatabase } from "./db/publisher-clients";

// Scopes the auth service issues for machine publishers (client_credentials
// grant). push proposes revisions through the owner routes; publish approves
// them through the moderation routes. Their meaning here is documented in
// "Machine publishing" in the service README.
export const MACHINE_SCOPE_PUSH = "extensions:push";
export const MACHINE_SCOPE_PUBLISH = "extensions:publish";

// Hardcoded production values; the env bindings allow non-production
// environments to point the verifier at a different issuer.
const DEFAULT_ISSUER = "https://auth.fossbilling.net";
const DEFAULT_JWKS_URL = "https://auth.fossbilling.net/.well-known/jwks.json";
const DEFAULT_AUDIENCE = "https://api.fossbilling.net";

const CLOCK_SKEW_SECONDS = 30;
const JWKS_TTL_MS = 5 * 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5000;

// Per-isolate JWKS cache. Key rotation propagates within JWKS_TTL_MS; a kid
// miss bypasses the cache once before failing, so an emergency rotation
// never waits out the TTL.
let cachedKeys: { url: string; keys: Jwk[]; expiresAt: number } | null = null;
let pendingFetch: { url: string; promise: Promise<Jwk[]> } | null = null;

// Minimal JWK view: only the fields this verifier reads. Declared locally
// rather than using JsonWebKey because this project compiles without DOM
// lib (see tsconfig), where that name resolves without the key fields.
interface Jwk {
  kty?: string;
  crv?: string;
  alg?: string;
  kid?: string;
  x?: string;
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fetchJwks(url: string): Promise<Jwk[]> {
  if (
    cachedKeys &&
    cachedKeys.url === url &&
    cachedKeys.expiresAt > Date.now()
  ) {
    return cachedKeys.keys;
  }
  if (pendingFetch && pendingFetch.url === url) {
    return pendingFetch.promise;
  }
  const promise = (async (): Promise<Jwk[]> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
      const document = (await res.json()) as { keys?: Jwk[] };
      if (!Array.isArray(document.keys)) throw new Error("JWKS has no keys");
      cachedKeys = {
        url,
        keys: document.keys,
        expiresAt: Date.now() + JWKS_TTL_MS
      };
      return cachedKeys.keys;
    } finally {
      clearTimeout(timeout);
      if (pendingFetch && pendingFetch.url === url) pendingFetch = null;
    }
  })();
  pendingFetch = { url, promise };
  return promise;
}

interface MachineTokenConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Verifies the JWT cryptographically and checks iss/aud/exp, but performs
// no authorization: the caller maps client_id to a developer afterwards.
async function verifySignature(
  token: string,
  config: MachineTokenConfig,
  refreshKeys: boolean
): Promise<{ clientId: string; scopes: string[] } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [
    string,
    string,
    string
  ];
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    return null;
  }
  if (!isRecord(header) || !isRecord(payload)) return null;
  // Pinned like bearer-assertion pins HS256: the auth service signs machine
  // tokens with EdDSA, and anything else fails closed here rather than
  // dispatching on attacker-controlled alg.
  if (header.alg !== "EdDSA") return null;

  let keys: Jwk[];
  try {
    if (refreshKeys) cachedKeys = null;
    keys = await fetchJwks(config.jwksUrl);
  } catch (error) {
    logWarn("auth", "Machine JWKS fetch failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
  const candidates =
    typeof header.kid === "string"
      ? keys.filter((key) => key.kid === header.kid)
      : keys;
  if (candidates.length === 0) {
    // Unknown kid: the issuer may have rotated since the cache filled.
    // One refresh before failing keeps an emergency rotation working.
    if (!refreshKeys) return verifySignature(token, config, true);
    return null;
  }

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  for (const jwk of candidates) {
    // A key whose type cannot produce EdDSA signatures is skipped rather
    // than failing the whole verification.
    if (jwk.alg && jwk.alg !== "EdDSA") continue;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk as unknown as JsonWebKey,
        { name: "Ed25519" },
        false,
        ["verify"]
      );
      const valid = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        signature,
        signingInput
      );
      if (!valid) continue;
    } catch {
      continue;
    }
    // Signature holds: now the claims.
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== config.issuer) return null;
    const aud = payload.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(config.audience)) return null;
    if (typeof payload.sub !== "string" || payload.sub.length === 0)
      return null;
    if (typeof payload.exp !== "number" || !Number.isInteger(payload.exp))
      return null;
    if (payload.exp + CLOCK_SKEW_SECONDS <= now) return null;
    if (
      payload.iat !== undefined &&
      (typeof payload.iat !== "number" ||
        !Number.isInteger(payload.iat) ||
        payload.iat - CLOCK_SKEW_SECONDS > now)
    ) {
      return null;
    }
    const scopes =
      typeof payload.scope === "string"
        ? payload.scope.split(" ").filter(Boolean)
        : [];
    return { clientId: payload.sub, scopes };
  }
  return null;
}

// Verifies auth-issued client_credentials JWTs and resolves the API-side
// authorization (publisher_clients row): which developer this client may
// publish for, which service user its writes attribute to, and whether it
// may approve. Unknown or revoked clients fail closed with no principal.
export const machineTokenVerifier: TokenVerifier = {
  async verify(
    token,
    platform: PlatformContext
  ): Promise<AuthPrincipal | null> {
    const config: MachineTokenConfig = {
      issuer: platform.getEnv("AUTH_ISSUER") ?? DEFAULT_ISSUER,
      jwksUrl: platform.getEnv("AUTH_JWKS_URL") ?? DEFAULT_JWKS_URL,
      audience: platform.getEnv("EXTENSIONS_API_AUDIENCE") ?? DEFAULT_AUDIENCE
    };
    const verified = await verifySignature(token, config, false);
    if (!verified) return null;
    // platform.raw is the Hono context: the only path from a TokenVerifier
    // to the D1 binding, since verifiers receive the platform abstraction
    // rather than route-level c.env.
    const rawEnv = platform.raw.env as unknown as {
      DB_EXTENSIONS?: D1Database;
    };
    if (!rawEnv.DB_EXTENSIONS) return null;
    const mapping = await new PublisherClientsDatabase(
      getExtensionsDb(rawEnv.DB_EXTENSIONS)
    ).getActive(verified.clientId);
    if (mapping.error || !mapping.data) return null;
    return {
      userId: mapping.data.serviceUserId,
      scope: "machine",
      clientId: verified.clientId,
      scopes: verified.scopes,
      canPublish: mapping.data.canPublish
    };
  }
};
