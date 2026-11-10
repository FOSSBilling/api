export interface StatsData {
  releaseSizes: ReleaseSizeData[];
  phpVersions: PhpVersionData[];
  patchesPerRelease: PatchesPerReleaseData[];
  releasesPerYear: ReleasesPerYearData[];
}

export interface ReleaseSizeData {
  version: string;
  size_mb: number;
  released_on: string;
}

export interface PhpVersionData {
  version: string;
  php_version: string;
  released_on: string;
}

export interface PatchesPerReleaseData {
  version_line: string;
  patch_count: number;
}

export interface ReleasesPerYearData {
  year: string;
  release_count: number;
}
