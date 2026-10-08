import { EXTENSION_TYPES } from "../v2/schemas/extensions";

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
  // Always present ("" when unknown): legacy FOSSBilling templates render
  // with strict_variables, where a missing key throws on old installs that
  // can no longer receive template fixes.
  icon_url: string;
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
  // Always present ("" when unknown) for the same legacy strict_variables
  // reason as Extension.icon_url.
  URL: string;
};

export type User = {
  type: "user";
  name: string;
  id: Lowercase<string>;
  // Always present ("" when unknown) for the same legacy strict_variables
  // reason as Extension.icon_url.
  URL: string;
};

export type Release = {
  tag: string;
  date: string;
  download_url: string;
  changelog_url?: string;
  min_fossbilling_version: string;
};
