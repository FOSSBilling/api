import { gt } from "semver";
import { sortReleasesDescending } from "../../../lib/releases";
import { parseJSON } from "../../../lib/json";
import { EXTENSION_TYPES } from "../v2/schemas/extensions";

export { sortReleasesDescending, parseJSON };

export type Extension = {
  id: string;
  // Derived from v2 rather than restated: both describe the same
  // extensions.type column (v1/database.ts already reads v2's db/schema), so a
  // new extension type would otherwise pass v2's runtime validator while v1's
  // type silently disagreed.
  type: (typeof EXTENSION_TYPES)[number];
  name: string;
  description: string;
  author: Author;
  releases: Release[];
  website: string;
  license: {
    name: string;
    URL?: string;
  };
  icon_url?: string;
  readme: string;
  source: Repository;
  version: string;
  download_url: string;
};

export type Repository = {
  type: "github" | "gitlab" | "custom";
  repo: string;
};

export type Author = Organization | User;

export type Organization = {
  type: "organization";
  name: string;
  id: Lowercase<string>;
  URL?: string;
};

export type User = {
  type: "user";
  name: string;
  id: Lowercase<string>;
  URL?: string;
};

export type Release = {
  tag: string;
  date: string;
  download_url: string;
  changelog_url?: string;
  min_fossbilling_version: string;
};

export function getLatestRelease(extension: Extension): Release | undefined {
  if (extension.releases.length === 0) {
    return undefined;
  }

  let latestRelease = extension.releases[0];
  for (let i = 1; i < extension.releases.length; i++) {
    const release = extension.releases[i];
    try {
      if (gt(release.tag, latestRelease.tag)) {
        latestRelease = release;
      }
    } catch {
      // Ignore invalid semver tags
    }
  }

  return latestRelease;
}
