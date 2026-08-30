// FOSSBilling/FOSSBilling's `create-release.yml` mirrors every release
// archive to R2 in its "Upload Release Archive to R2" step - github.com
// has no AAAA record, so this mirror is what lets IPv6-only hosts (no
// NAT64) actually download an update. See FOSSBilling/FOSSBilling#2479.
const RELEASES_DOWNLOAD_BASE_URL = "https://download.fossbilling.org/releases";

export interface ReleaseR2Object {
  downloadUrl: string;
  digest: string | null;
}

// `digest` is custom metadata the release workflow sets explicitly on the
// R2 upload (already carrying the "sha256:" prefix), computed once in CI
// from the exact uploaded file - see that repo's create-release.yml.
export async function getReleaseR2Object(
  bucket: R2Bucket,
  version: string
): Promise<ReleaseR2Object | null> {
  const archiveName = `FOSSBilling-${version}.zip`;
  const object = await bucket.head(`releases/${version}/${archiveName}`);
  if (!object) return null;

  return {
    downloadUrl: `${RELEASES_DOWNLOAD_BASE_URL}/${version}/${archiveName}`,
    digest: object.customMetadata?.digest ?? null
  };
}
