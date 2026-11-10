import { PACKAGE_LIMITS } from "../limits";
import { sha256 } from "../checksum";
import { PackageError } from "../errors";
import { boundedBytes, type PackageStore } from "../store";
import { signS3Request } from "./sigv4";

// Includes generated manifest and ZIP headers as well as the source contents.
const MAX_STORED_BYTES = PACKAGE_LIMITS.expandedBytes + 1024 * 1024;

export function b2ObjectStore(
  getEnv: (name: string) => string | undefined,
  kind: "packages" | "assets",
  signal?: AbortSignal
): PackageStore {
  const get = (suffix: string) => {
    const value = getEnv(`EXTENSION_${kind.toUpperCase()}_S3_${suffix}`);
    if (!value)
      throw unavailable("Package storage configuration is incomplete");
    return value;
  };
  const origin = new URL(get("ENDPOINT"));
  const bucket = get("BUCKET");
  const prefix =
    kind === "packages"
      ? (getEnv("EXTENSION_PACKAGES_S3_PREFIX") ?? "local")
      : "";
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    !/^[a-zA-Z0-9-]+$/.test(bucket) ||
    (kind === "packages" && !/^[a-zA-Z0-9_-]+$/.test(prefix))
  )
    throw unavailable("Invalid package storage configuration");
  if (kind === "assets") {
    let base: URL;
    try {
      base = new URL(getEnv("EXTENSION_ASSETS_PUBLIC_URL") ?? "");
    } catch {
      throw unavailable("Invalid public asset URL configuration");
    }
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw unavailable("Invalid public asset URL configuration");
  }
  const credentials = {
    accessKeyId: get("ACCESS_KEY_ID"),
    secretAccessKey: get("SECRET_ACCESS_KEY"),
    region: get("REGION")
  };
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  const pattern =
    kind === "assets"
      ? new RegExp(`^extensions/${uuid}/icons/${uuid}\\.(?:svg|png|avif)$`)
      : new RegExp(`^${uuid}$`);
  function target(key: string) {
    // Keys come from D1 reservations, never from caller-supplied paths.
    if (!pattern.test(key)) throw unavailable("Invalid storage object ID");
    return new URL(
      `/${bucket}/${kind === "packages" ? `${prefix}/packages/` : ""}${key}`,
      origin
    );
  }
  async function request(url: URL, init: RequestInit) {
    try {
      return await fetch(
        await signS3Request(
          url,
          {
            ...init,
            redirect: "manual",
            // Read current origin state; public image caching belongs to the CDN.
            cache: "no-store",
            signal: AbortSignal.any([
              ...(signal ? [signal] : []),
              AbortSignal.timeout(15000)
            ])
          },
          credentials
        )
      );
    } catch {
      throw unavailable("Package storage request failed");
    }
  }
  return {
    async put(key, bytes, checksum) {
      if (
        bytes.byteLength > MAX_STORED_BYTES ||
        (await sha256(bytes)) !== checksum
      )
        throw unavailable("Package object failed checksum or size validation");
      const response = await request(target(key), {
        method: "PUT",
        body: bytes,
        headers: {
          "Content-Type":
            kind === "packages"
              ? "application/zip"
              : key.endsWith(".svg")
                ? "image/svg+xml"
                : key.endsWith(".avif")
                  ? "image/avif"
                  : "image/png",
          "Cache-Control":
            kind === "packages"
              ? "private, no-store"
              : "public, max-age=31536000, immutable",
          "x-amz-content-sha256": checksum,
          "x-amz-meta-sha256": checksum
        }
      });
      await response.body?.cancel();
      if (!response.ok) throw unavailable("Package upload failed");
    },
    async get(key, checksum) {
      const response = await request(target(key), { method: "GET" });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (
        response.status !== 200 ||
        (checksum && response.headers.get("x-amz-meta-sha256") !== checksum)
      ) {
        await response.body?.cancel();
        throw unavailable(
          "Stored package is unavailable or has a different checksum"
        );
      }
      // Verify actual bytes before returning an object. The size
      // bound also applies to responses without Content-Length (e.g. chunked).
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await boundedBytes(response.body, MAX_STORED_BYTES);
      } catch {
        throw unavailable(
          "Stored package could not be read within its size limit"
        );
      }
      if (checksum && (await sha256(bytes)) !== checksum)
        throw unavailable("Stored package failed checksum verification");
      return new Blob([bytes]).stream();
    },
    async delete(key) {
      const url = target(key);
      const head = await request(url, { method: "HEAD" });
      await head.body?.cancel();
      if (head.status === 404) return;
      const version = head.headers.get("x-amz-version-id");
      if (!head.ok || !version)
        throw unavailable("Unable to identify package version for cleanup");
      // B2 DELETE without versionId only adds a marker and keeps billable bytes.
      url.searchParams.set("versionId", version);
      const response = await request(url, { method: "DELETE" });
      await response.body?.cancel();
      if (!response.ok && response.status !== 404)
        throw unavailable("Package cleanup failed");
    }
  };
}
function unavailable(message: string) {
  return new PackageError("PACKAGE_UNAVAILABLE", message, 503);
}
