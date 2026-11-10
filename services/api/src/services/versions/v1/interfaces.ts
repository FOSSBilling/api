export type ReleaseDetails = {
  version: string;
  released_on: string;
  minimum_php_version: string;
  // Always the GitHub asset URL - every FOSSBilling version ever released
  // trusts this, so it's the safe default for a client we can't identify.
  download_url: string;
  // The R2 mirror URL, if this release has one. Only versions >=
  // MIRROR_TRUST_MIN_VERSION have download.fossbilling.org in their signed
  // download-URL allowlist (Update::$allowedDownloadPrefixes) and will
  // accept it - see resolveReleaseForClient().
  mirror_download_url: string | null;
  size_bytes: number;
  is_prerelease: boolean;
  github_release_id: number;
  changelog: string;
  // SHA-256 digest of the release zip (`sha256:<hex>`), as computed by
  // GitHub; null for older assets predating GitHub's digest support.
  digest: string | null;
  // Digest for mirror_download_url. Set alongside it from the R2 object's
  // own custom metadata - see getReleaseR2Object().
  mirror_digest: string | null;
};

// The public response shape returned to FOSSBilling clients - download_url/digest
// already resolved to whichever source (GitHub or the R2 mirror) that specific
// client trusts. See resolveReleaseForClient().
export type ResolvedReleaseDetails = Omit<
  ReleaseDetails,
  "mirror_download_url" | "mirror_digest"
>;

export type Releases = {
  [version: string]: ReleaseDetails;
};
