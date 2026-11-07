import { PackageError } from "./errors";
import type { Context } from "hono";
import { b2PackageStore } from "./b2-store";
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
      !env.EXTENSION_IMAGE_BUCKET ||
      !env.PACKAGE_IMAGES
    ) {
      throw new PackageError(
        "PACKAGES_DISABLED",
        "Production package storage, images or download URL is not configured",
        503
      );
    }
  }
  const remote = getEnv("EXTENSION_PACKAGES_S3_ENDPOINT")
    ? b2PackageStore((name) => getEnv(name))
    : null;
  const packages = env.EXTENSION_PACKAGE_BUCKET;
  const images = env.EXTENSION_IMAGE_BUCKET;
  const bucketFor = (key: string) => {
    const bucket = key.startsWith("icons/") ? images : packages;
    if (!bucket)
      throw new PackageError(
        "PACKAGES_DISABLED",
        "Package or image storage is not configured",
        503
      );
    return bucket;
  };
  if (!remote && !packages) return null;
  return {
    async put(key, bytes, checksum) {
      if (remote && !key.startsWith("icons/"))
        return remote.put(key, bytes, checksum);
      const result = await bucketFor(key).put(key, bytes, {
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
      if (remote && !key.startsWith("icons/")) return remote.get(key, checksum);
      const object = await bucketFor(key).get(key);
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
      if (remote && !key.startsWith("icons/")) return remote.delete(key);
      await bucketFor(key).delete(key);
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
