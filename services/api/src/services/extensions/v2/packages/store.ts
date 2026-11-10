import { PackageError } from "@fossbilling/extension-packaging/errors";
import type { PackageStore } from "@fossbilling/extension-packaging/store";
import type { Context } from "hono";
import { b2ObjectStore } from "@fossbilling/extension-packaging/adapters/b2";
import { getPlatform } from "../../../../lib/middleware";

export function packageStore(c: Context): PackageStore | null {
  return configuredPackageStore((name) => getPlatform(c).getEnv(name));
}

export function configuredPackageStore(
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
      !getEnv("EXTENSION_ASSETS_PUBLIC_URL")
    ) {
      throw new PackageError(
        "PACKAGES_DISABLED",
        "Production package storage, images or download URL is not configured",
        503
      );
    }
  }
  const packages = b2ObjectStore(getEnv, "packages");
  const assets = b2ObjectStore(getEnv, "assets");
  const storeFor = (key: string) =>
    key.startsWith("extensions/") ? assets : packages;
  return {
    put: (key, bytes, checksum) => storeFor(key).put(key, bytes, checksum),
    get: (key, checksum) => storeFor(key).get(key, checksum),
    delete: (key) => storeFor(key).delete(key)
  };
}
