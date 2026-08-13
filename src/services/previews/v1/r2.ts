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

// `digest`/`commit-sha` are custom metadata FOSSBilling/FOSSBilling's
// ci.yml sets explicitly on the R2 upload (`digest` already carries the
// "sha256:" prefix - see that repo's ci.yml `upload-preview` job).
export async function getMainPreviewObject(
  bucket: R2Bucket
): Promise<MainPreviewObject | null> {
  const object = await bucket.head(MAIN_PREVIEW_KEY);
  if (!object) return null;

  return {
    commitSha: object.customMetadata?.["commit-sha"] ?? null,
    digest: object.customMetadata?.digest ?? null,
    sizeBytes: object.size,
    lastModified: object.uploaded.toISOString(),
    downloadUrl: MAIN_PREVIEW_DOWNLOAD_URL
  };
}
