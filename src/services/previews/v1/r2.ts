// The object FOSSBilling/FOSSBilling's ci.yml `upload-preview` job syncs to
// R2 on every main push - the same path served publicly at
// https://download.fossbilling.org/FOSSBilling-preview.zip.
const MAIN_PREVIEW_KEY = "FOSSBilling-preview.zip";
const MAIN_PREVIEW_DOWNLOAD_URL =
  "https://download.fossbilling.org/FOSSBilling-preview.zip";

export interface MainPreviewObject {
  commitSha: string | null;
  digest: string | null;
  sizeBytes: number;
  lastModified: string;
  downloadUrl: string;
}

// R2's zip and GitHub's own `FOSSBilling Preview` artifact zip for the same
// commit are two independently-built byte streams (see previews/v1's
// README), so the digest reported here has to come from this object's own
// metadata, not GitHub's. `sha256`/`commit-sha` are custom metadata the CI
// upload step sets explicitly - both are absent (null) until that step is
// added to FOSSBilling/FOSSBilling's ci.yml.
export async function getMainPreviewObject(
  bucket: R2Bucket
): Promise<MainPreviewObject | null> {
  const object = await bucket.head(MAIN_PREVIEW_KEY);
  if (!object) return null;

  const digest = object.customMetadata?.sha256;
  return {
    commitSha: object.customMetadata?.["commit-sha"] ?? null,
    digest: digest ? `sha256:${digest}` : null,
    sizeBytes: object.size,
    lastModified: object.uploaded.toISOString(),
    downloadUrl: MAIN_PREVIEW_DOWNLOAD_URL
  };
}
