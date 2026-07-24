function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlEncodeString(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

export interface AssertionOverrides {
  sub?: string;
  iat?: number;
  exp?: number;
}

/** Mints a compact HS256 assertion matching what bearer-assertion.ts verifies. */
export async function signAssertion(
  secret: string,
  overrides: AssertionOverrides = {}
): Promise<string> {
  const iat = overrides.iat ?? Math.floor(Date.now() / 1000);
  const payload = {
    sub: overrides.sub ?? "user-1",
    iat,
    exp: overrides.exp ?? iat + 60
  };

  const headerB64 = base64UrlEncodeString(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  );
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );

  return `${headerB64}.${payloadB64}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}
