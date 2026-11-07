export type Extension = {
  id: string;
  type:
    | "mod"
    | "theme"
    | "payment-gateway"
    | "server-manager"
    | "domain-registrar"
    | "hook"
    | "translation";
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
  is_latest?: boolean;
  date: string;
  download_url: string;
  changelog_url?: string;
  min_fossbilling_version: string;
};
