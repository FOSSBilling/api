export type ReleaseDetails = {
  version: string;
  released_on: string;
  minimum_php_version: string;
  download_url: string;
  size_bytes: number;
  is_prerelease: boolean;
  github_release_id: number;
  changelog: string;
  // SHA-256 digest of the release zip (`sha256:<hex>`), as computed by
  // GitHub; null for older assets predating GitHub's digest support.
  digest: string | null;
};

export type Releases = {
  [version: string]: ReleaseDetails;
};
