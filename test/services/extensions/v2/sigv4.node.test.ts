import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signS3Request } from "../../../../src/lib/adapters/b2/sigv4";

const credentials = {
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  region: "eu-central-003"
};
const now = new Date("2024-01-02T03:04:05.000Z");
const EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function authParts(request: Request) {
  const auth = request.headers.get("Authorization") ?? "";
  const credential = auth.match(/Credential=([^,]+)/)?.[1] ?? "";
  const signedHeaders = auth.match(/SignedHeaders=([^,]+)/)?.[1] ?? "";
  const signature = auth.match(/Signature=([0-9a-f]+)/)?.[1] ?? "";
  return { auth, credential, signedHeaders, signature };
}

// Independent recomputation with Node crypto (not WebCrypto) to catch wiring
// bugs rather than just snapshotting our own output.
function expectedSignature(
  canonicalRequest: string,
  amzDate: string,
  scope: string
): string {
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");
  const hmac = (key: string | Buffer, data: string) =>
    createHmac("sha256", key).update(data).digest();
  const dateKey = hmac(
    `AWS4${credentials.secretAccessKey}`,
    scope.split("/")[0]
  );
  const regionKey = hmac(dateKey, credentials.region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

describe("SigV4 signer", () => {
  it("signs GET with the empty payload hash and sorted headers", async () => {
    const request = await signS3Request(
      new URL("https://s3.example.test/private-packages/local/packages/id"),
      { method: "GET" },
      credentials,
      now
    );
    expect(request.headers.get("x-amz-date")).toBe("20240102T030405Z");
    expect(request.headers.get("x-amz-content-sha256")).toBe(EMPTY);
    expect(request.headers.get("host")).toBe("s3.example.test");
    const { auth, credential, signedHeaders, signature } = authParts(request);
    expect(auth.startsWith("AWS4-HMAC-SHA256 ")).toBe(true);
    expect(credential).toBe("test-key/20240102/eu-central-003/s3/aws4_request");
    expect(signedHeaders).toBe("host;x-amz-content-sha256;x-amz-date");
    const canonicalRequest = [
      "GET",
      "/private-packages/local/packages/id",
      "",
      "host:s3.example.test\n" +
        `x-amz-content-sha256:${EMPTY}\n` +
        "x-amz-date:20240102T030405Z\n",
      signedHeaders,
      EMPTY
    ].join("\n");
    expect(signature).toBe(
      expectedSignature(
        canonicalRequest,
        "20240102T030405Z",
        credential.split("/").slice(1).join("/")
      )
    );
  });

  it("passes through the caller checksum and signs metadata headers on PUT", async () => {
    const checksum = "a".repeat(64);
    const request = await signS3Request(
      new URL("https://s3.example.test/bucket/key"),
      {
        method: "PUT",
        body: new Uint8Array([1, 2, 3]),
        headers: {
          "Content-Type": "application/zip",
          "Cache-Control": "private, no-store",
          "x-amz-content-sha256": checksum,
          "x-amz-meta-sha256": checksum
        }
      },
      credentials,
      now
    );
    expect(request.headers.get("x-amz-content-sha256")).toBe(checksum);
    const { signedHeaders, signature } = authParts(request);
    expect(signedHeaders).toBe(
      "cache-control;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256"
    );
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds the versionId query to the signature", async () => {
    const signed = (versionId: string) =>
      signS3Request(
        new URL(
          `https://s3.example.test/bucket/key?versionId=${encodeURIComponent(versionId)}`
        ),
        { method: "DELETE" },
        credentials,
        now
      );
    const [first, second] = await Promise.all([
      signed("stored-version+1"),
      signed("other-version")
    ]);
    expect(new URL(first.url).searchParams.get("versionId")).toBe(
      "stored-version+1"
    );
    expect(authParts(first).signature).not.toBe(authParts(second).signature);
  });
});
