import { afterEach, describe, expect, it, vi } from "vitest";
import { b2ObjectStore } from "../../../../src/lib/adapters/b2/package-store";
import {
  sha256,
  PACKAGE_LIMITS
} from "../../../../src/services/extensions/v2/package-builder";

const objectId = "134cf413-b5ab-4f57-b2ad-520020af880d";
const config: Record<string, string> = {
  ENDPOINT: "https://s3.example.test",
  REGION: "eu-central-003",
  BUCKET: "private-packages",
  ACCESS_KEY_ID: "test-key",
  SECRET_ACCESS_KEY: "test-secret"
};
const store = (overrides: Record<string, string | undefined> = {}) =>
  b2ObjectStore(
    (name) =>
      ({ ...config, ...overrides })[name.replace("EXTENSION_PACKAGES_S3_", "")],
    "packages"
  );
afterEach(() => vi.unstubAllGlobals());

describe("B2 object storage", () => {
  it("signs ZIP writes and verifies downloaded bytes", async () => {
    const bytes = new Uint8Array(new TextEncoder().encode("synthetic ZIP"));
    const checksum = await sha256(bytes);
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (request: Request) => {
      requests.push(request);
      if (request.method === "PUT") {
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
        return new Response(null, { status: 200 });
      }
      return new Response(bytes, {
        headers: { "x-amz-meta-sha256": checksum }
      });
    });
    const storage = store();
    await storage.put(objectId, bytes, checksum);
    expect(
      new Uint8Array(
        await new Response(await storage.get(objectId, checksum)).arrayBuffer()
      )
    ).toEqual(bytes);
    expect(requests.map((r) => r.method)).toEqual(["PUT", "GET"]);
    for (const request of requests) {
      expect(request.url).toBe(
        `https://s3.example.test/private-packages/local/packages/${objectId}`
      );
      expect(request.headers.get("Authorization")).toMatch(
        /^AWS4-HMAC-SHA256 /
      );
      expect(request.redirect).toBe("manual");
    }
    expect(requests[0].headers.get("Cache-Control")).toBe("private, no-store");
    expect(requests[0].headers.get("x-amz-content-sha256")).toBe(checksum);
  });

  it.each(["svg", "avif", "png"])(
    "stores and cleans up public %s assets under their UUID path",
    async (format) => {
      const bytes = new Uint8Array(new TextEncoder().encode("prepared image"));
      const checksum = await sha256(bytes);
      const key = `extensions/${objectId}/icons/${objectId}.${format}`;
      const requests: Request[] = [];
      vi.stubGlobal("fetch", async (request: Request) => {
        requests.push(request);
        return new Response(request.method === "GET" ? bytes : null, {
          headers: {
            "x-amz-meta-sha256": checksum,
            "x-amz-version-id": "asset-version"
          }
        });
      });
      const storage = b2ObjectStore(
        (name) =>
          name === "EXTENSION_ASSETS_PUBLIC_URL"
            ? "https://assets.example.test"
            : { ...config, BUCKET: "public-assets" }[
                name.replace("EXTENSION_ASSETS_S3_", "")
              ],
        "assets"
      );
      await storage.put(key, bytes, checksum);
      expect(await new Response(await storage.get(key, checksum)).text()).toBe(
        "prepared image"
      );
      await storage.delete(key);
      expect(requests.map((r) => r.method)).toEqual([
        "PUT",
        "GET",
        "HEAD",
        "DELETE"
      ]);
      for (const request of requests) {
        expect(new URL(request.url).pathname).toBe(`/public-assets/${key}`);
        expect(request.headers.get("Authorization")).toContain(
          "AWS4-HMAC-SHA256"
        );
        expect(request.cache).toBe("no-store");
      }
      expect(requests[0].headers.get("Content-Type")).toBe(
        format === "svg" ? "image/svg+xml" : `image/${format}`
      );
      expect(requests[0].headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable"
      );
      expect(new URL(requests[3].url).searchParams.get("versionId")).toBe(
        "asset-version"
      );
    }
  );

  it("rejects corrupted bodies even when checksum metadata matches", async () => {
    const checksum = await sha256(
      new Uint8Array(new TextEncoder().encode("expected"))
    );
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("corrupted", {
          headers: { "x-amz-meta-sha256": checksum }
        })
    );
    await expect(store().get(objectId, checksum)).rejects.toThrow(
      "checksum verification"
    );
  });

  it("bounds chunked downloads without trusting Content-Length", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new Uint8Array(PACKAGE_LIMITS.expandedBytes + 1024 * 1024 + 1)
              );
              controller.close();
            }
          })
        )
    );
    await expect(store().get(objectId)).rejects.toThrow("size limit");
  });

  it("deletes the stored version rather than creating a delete marker", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (request: Request) => {
      requests.push(request);
      return request.method === "HEAD"
        ? new Response(null, {
            headers: { "x-amz-version-id": "stored-version+1" }
          })
        : new Response(null, { status: 204 });
    });
    await store().delete(objectId);
    expect(requests.map((r) => r.method)).toEqual(["HEAD", "DELETE"]);
    expect(new URL(requests[1].url).searchParams.get("versionId")).toBe(
      "stored-version+1"
    );
  });

  it("treats missing reads and cleanup as absent, but fails closed on storage errors", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    expect(await store().get(objectId)).toBeNull();
    await store().delete(objectId);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockImplementation(async () => new Response(null, { status: 403 }));
    await expect(store().get(objectId)).rejects.toThrow("unavailable");
    await expect(store().delete(objectId)).rejects.toThrow("cleanup");
    fetch.mockImplementation(async () => {
      throw new Error("upstream timeout");
    });
    await expect(store().get(objectId)).rejects.toThrow("request failed");
  });

  it("rejects failed uploads and retains cleanup failures for retry", async () => {
    const bytes = new Uint8Array(new TextEncoder().encode("ZIP"));
    vi.stubGlobal("fetch", async (request: Request) =>
      request.method === "HEAD"
        ? new Response(null, { headers: { "x-amz-version-id": "v1" } })
        : new Response(null, { status: 503 })
    );
    await expect(
      store().put(objectId, bytes, await sha256(bytes))
    ).rejects.toThrow("upload failed");
    await expect(store().delete(objectId)).rejects.toThrow("cleanup failed");
  });

  it("rejects unsafe configuration, keys and mismatched upload checksums before network access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const ENDPOINT of [
      "http://s3.example.test",
      "https://key:secret@s3.example.test",
      "https://s3.example.test/path",
      "https://s3.example.test?key=value"
    ])
      expect(() => store({ ENDPOINT })).toThrow("configuration");
    expect(() => store({ SECRET_ACCESS_KEY: undefined })).toThrow("incomplete");
    expect(() => store({ PREFIX: "../other" })).toThrow("configuration");
    await expect(store().get("../other")).rejects.toThrow("object ID");
    await expect(
      store().put(objectId, new Uint8Array([1]), "wrong")
    ).rejects.toThrow("checksum");
    expect(fetch).not.toHaveBeenCalled();
  });
});
