import { AuthPrincipal, TokenVerifier } from "./interfaces";

const CLOCK_SKEW_SECONDS = 5;

interface AssertionPayload {
  sub: string;
  iat: number;
  exp: number;
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized + "=".repeat(4 - (normalized.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isAssertionPayload(value: unknown): value is AssertionPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sub === "string" &&
    record.sub.length > 0 &&
    typeof record.iat === "number" &&
    typeof record.exp === "number"
  );
}

// Verifies a compact HS256 assertion (header.payload.signature). The header
// is never parsed or trusted to pick the algorithm, which avoids alg-confusion.
export const bearerAssertionVerifier: TokenVerifier = {
  async verify(token, platform): Promise<AuthPrincipal | null> {
    const secret = platform.getEnv("ASSERTION_SIGNING_SECRET");
    if (!secret) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder().decode(base64UrlDecode(payloadB64))
      );
    } catch {
      return null;
    }
    if (!isAssertionPayload(payload)) return null;

    let signature: Uint8Array;
    try {
      signature = base64UrlDecode(signatureB64);
    } catch {
      return null;
    }

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
    if (!valid) return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;
    if (payload.iat > now + CLOCK_SKEW_SECONDS) return null;

    return { userId: payload.sub, scope: "assertion" };
  }
};
