import { vi } from "vitest";

// Matches the M2M_JWKS_URL binding configured in vitest.config.ts.
export const M2M_JWKS_URL = "https://auth.example.test/.well-known/jwks.json";
const KID = "test-m2m-key";

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

let keyPair: CryptoKeyPair | null = null;
let publicJwk: JsonWebKey | null = null;

async function ensureKeyPair(): Promise<void> {
  if (!keyPair) {
    keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify"
    ])) as CryptoKeyPair;
    publicJwk = (await crypto.subtle.exportKey(
      "jwk",
      keyPair.publicKey
    )) as JsonWebKey;
  }
}

export interface AccessTokenOverrides {
  clientId?: string;
  sub?: string;
  scopes?: string[];
  iss?: string;
  aud?: string;
  exp?: number;
  typ?: string;
}

/** Mints a compact EdDSA access token matching what m2m-bearer.ts verifies. */
export async function signAccessToken(
  overrides: AccessTokenOverrides = {}
): Promise<string> {
  await ensureKeyPair();
  const clientId = overrides.clientId ?? "modules-publisher";
  const iat = Math.floor(Date.now() / 1000);
  const header = base64UrlEncodeString(
    JSON.stringify({
      alg: "EdDSA",
      typ: overrides.typ ?? "at+jwt",
      kid: KID
    })
  );
  const payload = base64UrlEncodeString(
    JSON.stringify({
      iss: overrides.iss ?? "https://auth.example.test",
      aud: overrides.aud ?? "https://api.fossbilling.net",
      sub: overrides.sub ?? clientId,
      client_id: clientId,
      scope: (
        overrides.scopes ?? ["extensions:push", "extensions:publish"]
      ).join(" "),
      iat,
      exp: overrides.exp ?? iat + 600,
      jti: crypto.randomUUID()
    })
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    (keyPair as CryptoKeyPair).privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

// Routes the JWKS fetch to the in-test key pair by stubbing the global the
// jose client fetches through (the pool has no fetchMock export).
export async function activateM2mJwks(): Promise<void> {
  await ensureKeyPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url !== M2M_JWKS_URL) {
        throw new Error(`unexpected fetch in m2m test: ${url}`);
      }
      return new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, kid: KID, alg: "EdDSA", use: "sig" }]
        }),
        { headers: { "content-type": "application/json" } }
      );
    })
  );
}

export function deactivateM2mJwks(): void {
  vi.unstubAllGlobals();
}
