import { PackageError } from "./errors";
import type { Context } from "hono";
import { b2ObjectStore } from "./b2-store";
import { getPlatform } from "../../../../lib/middleware";

export interface PackageStore {
  put(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    checksum: string
  ): Promise<void>;
  get(
    key: string,
    checksum?: string
  ): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
}

export function packageStore(
  c: Context<{ Bindings: CloudflareBindings }>
): PackageStore | null {
  return configuredPackageStore(c.env, (name) => getPlatform(c).getEnv(name));
}

export function configuredPackageStore(
  env: CloudflareBindings,
  getEnv: (name: string) => string | undefined
): PackageStore | null {
  const mode = getEnv("EXTENSION_PACKAGES_MODE");
  const production = getEnv("ENVIRONMENT") === "production";
  if (mode !== "enabled" && !(mode === "local" && !production)) return null;
  if (production) {
    const base = getEnv("EXTENSION_PACKAGES_BASE_URL");
    let url: URL;
    try {
      url = new URL(base ?? "");
    } catch {
      throw new PackageError(
        "PACKAGES_DISABLED",
        "Package download URL is not configured",
        503
      );
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/extensions/v2" ||
      !getEnv("EXTENSION_PACKAGES_S3_ENDPOINT") ||
      !getEnv("EXTENSION_PACKAGES_S3_PREFIX") ||
      getEnv("EXTENSION_PACKAGES_S3_PREFIX") === "local" ||
      !getEnv("EXTENSION_ASSETS_S3_ENDPOINT") ||
      !getEnv("EXTENSION_ASSETS_PUBLIC_URL") ||
      !env.PACKAGE_IMAGES
    ) {
      throw new PackageError(
        "PACKAGES_DISABLED",
        "Production package storage, images or download URL is not configured",
        503
      );
    }
  }
  const packages = getEnv("EXTENSION_PACKAGES_S3_ENDPOINT")
    ? b2ObjectStore(getEnv, "packages")
    : null;
  const assets = getEnv("EXTENSION_ASSETS_S3_ENDPOINT")
    ? b2ObjectStore(getEnv, "assets")
    : null;
  const bucket = env.EXTENSION_PACKAGE_BUCKET;
  if (!packages && !bucket) return null;
  const localBucket = () => {
    if (!bucket)
      throw new PackageError(
        "PACKAGES_DISABLED",
        "Storage is not configured",
        503
      );
    return bucket;
  };
  const remoteFor = (key: string) =>
    key.startsWith("extensions/") ? assets : packages;
  return {
    async put(key, bytes, checksum) {
      const remote = remoteFor(key);
      if (remote) return remote.put(key, bytes, checksum);
      const result = await localBucket().put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: checksum,
        httpMetadata: {
          contentType: key.endsWith(".avif")
            ? "image/avif"
            : key.endsWith(".png")
              ? "image/png"
              : key.endsWith(".svg")
                ? "image/svg+xml"
                : "application/zip",
          cacheControl: "private, no-store"
        }
      });
      if (!result) throw new Error("Package object already exists");
    },
    async get(key, checksum) {
      const remote = remoteFor(key);
      if (remote) return remote.get(key, checksum);
      const object = await localBucket().get(key);
      if (!object) return null;
      if (checksum) {
        const actual = object.checksums.sha256;
        const hex = actual
          ? Array.from(new Uint8Array(actual), (byte) =>
              byte.toString(16).padStart(2, "0")
            ).join("")
          : null;
        if (hex !== checksum) {
          await object.body.cancel();
          throw new PackageError(
            "PACKAGE_UNAVAILABLE",
            "Stored object failed checksum verification",
            503
          );
        }
      }
      return object.body;
    },
    async delete(key) {
      const remote = remoteFor(key);
      if (remote) return remote.delete(key);
      await localBucket().delete(key);
    }
  };
}

export async function boundedBytes(
  body: ReadableStream<Uint8Array> | null,
  limit: number
) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new PackageError(
          "BODY_TOO_LARGE",
          "Upload exceeds size limit",
          413
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
