// Minimal AWS Signature Version 4 signer for S3-compatible storage.
//
// Signs the B2 package store requests and its short-lived upload URLs.
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))
  );
}

async function hmac(
  key: Uint8Array<ArrayBuffer> | ArrayBuffer | string,
  data: string
): Promise<ArrayBuffer> {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

// encodeURIComponent leaves !'()* unescaped; SigV4 requires them escaped.
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalUri(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

function canonicalQueryString(searchParams: URLSearchParams): string {
  return [...searchParams.entries()]
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .sort()
    .join("&");
}

// PUT callers provide validated bytes and their checksum; other operations have no body.
export interface S3RequestInit extends Omit<RequestInit, "body"> {
  body?: Uint8Array<ArrayBuffer>;
}

/** Sign a request with SigV4 and return a new `Request` carrying the auth headers. */
export async function signS3Request(
  url: URL | string,
  init: S3RequestInit,
  credentials: S3Credentials,
  now: Date = new Date()
): Promise<Request> {
  const target = new URL(url.toString());
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const amzDate = signingDate(now);
  const payloadHash =
    headers.get("x-amz-content-sha256") ??
    (init.body == null ? EMPTY_SHA256 : null);
  if (!payloadHash)
    throw new Error("S3 uploads require an explicit payload checksum");

  headers.set("x-amz-date", amzDate);
  headers.set("x-amz-content-sha256", payloadHash);
  if (!headers.has("host")) headers.set("host", target.host);

  // Sign the transport headers plus any B2/S3 metadata headers the caller
  // set. Other headers (user-agent, accept, ...) stay unsigned so proxies
  // and runtimes can add them without breaking the signature.
  const signedNames = new Set(["host", "x-amz-content-sha256", "x-amz-date"]);
  headers.forEach((_value, name) => {
    if (
      name.startsWith("x-amz-") ||
      name === "content-type" ||
      name === "cache-control"
    )
      signedNames.add(name);
  });
  const signedHeaders = [...signedNames].sort();
  const scope = signingScope(amzDate, credentials);
  const signature = await sign(
    method,
    target,
    headers,
    signedHeaders,
    payloadHash,
    credentials,
    amzDate
  );

  headers.set(
    "Authorization",
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`
  );
  return new Request(target, { ...init, headers });
}

function signingDate(now: Date) {
  return now
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function signingScope(amzDate: string, credentials: S3Credentials) {
  return `${amzDate.slice(0, 8)}/${credentials.region}/s3/aws4_request`;
}

async function sign(
  method: string,
  target: URL,
  headers: Headers,
  signedHeaders: string[],
  payloadHash: string,
  credentials: S3Credentials,
  amzDate: string
) {
  const canonicalHeaders = signedHeaders
    .map(
      (name) =>
        `${name}:${headers.get(name)?.trim().replace(/\s+/g, " ") ?? ""}\n`
    )
    .join("");

  const canonicalRequest = [
    method,
    canonicalUri(target.pathname),
    canonicalQueryString(target.searchParams),
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash
  ].join("\n");
  const dateStamp = amzDate.slice(0, 8);
  const scope = signingScope(amzDate, credentials);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest)
  ].join("\n");

  let signingKey = await hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  for (const value of [credentials.region, "s3", "aws4_request"])
    signingKey = await hmac(signingKey, value);
  return toHex(await hmac(signingKey, stringToSign));
}

export async function presignS3Put(
  target: URL,
  requiredHeaders: Record<string, string>,
  credentials: S3Credentials,
  expiresIn: number,
  now: Date
) {
  const url = new URL(target);
  const headers = new Headers(requiredHeaders);
  headers.set("host", url.host);
  const signedHeaders = [...headers.keys()].sort();
  const amzDate = signingDate(now);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set(
    "X-Amz-Credential",
    `${credentials.accessKeyId}/${signingScope(amzDate, credentials)}`
  );
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(expiresIn));
  url.searchParams.set("X-Amz-SignedHeaders", signedHeaders.join(";"));
  url.searchParams.set(
    "X-Amz-Signature",
    await sign(
      "PUT",
      url,
      headers,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
      credentials,
      amzDate
    )
  );
  return url.href;
}
