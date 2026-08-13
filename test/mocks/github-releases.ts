export const mockGitHubReleases = [
  {
    id: 1001,
    tag_name: "0.5.0",
    name: "0.5.0",
    published_at: "2023-01-01T00:00:00Z",
    prerelease: false,
    body: "## 0.5.0\n- Initial release",
    assets: [
      {
        name: "FOSSBilling.zip",
        browser_download_url:
          "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.5.0/FOSSBilling.zip",
        size: 1024000
      }
    ]
  },
  {
    id: 1002,
    tag_name: "0.5.1",
    name: "0.5.1",
    published_at: "2023-02-01T00:00:00Z",
    prerelease: false,
    body: "## 0.5.1\n- Bug fixes",
    assets: [
      {
        name: "FOSSBilling.zip",
        browser_download_url:
          "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.5.1/FOSSBilling.zip",
        size: 1025000
      }
    ]
  },
  {
    id: 1003,
    tag_name: "0.5.2",
    name: "0.5.2",
    published_at: "2023-03-01T00:00:00Z",
    prerelease: false,
    body: "## 0.5.2\n- More fixes",
    assets: [
      {
        name: "FOSSBilling.zip",
        browser_download_url:
          "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.5.2/FOSSBilling.zip",
        size: 1026000
      }
    ]
  },
  {
    id: 1004,
    tag_name: "0.6.0",
    name: "0.6.0",
    published_at: "2023-04-01T00:00:00Z",
    prerelease: false,
    body: "## 0.6.0\n- New features",
    assets: [
      {
        name: "FOSSBilling.zip",
        browser_download_url:
          "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.6.0/FOSSBilling.zip",
        size: 1030000,
        digest:
          "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      }
    ]
  }
];

export const mockComposerJson = {
  require: {
    php: "^8.1"
  }
};

export const mockComposerJsonOldVersion = {
  require: {
    php: "^8.0"
  }
};
