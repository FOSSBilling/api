import { PackageError } from "./errors";
import type { GitHubPackageSource } from "./processor";

export async function downloadGitHubReleaseAsset(
  source: GitHubPackageSource,
  authorization: string | null,
  signal: AbortSignal
) {
  if (!authorization?.startsWith("Bearer "))
    throw new PackageError(
      "PACKAGE_UNAVAILABLE",
      "GitHub App authentication is unavailable",
      503
    );
  const options = {
    redirect: "manual" as const,
    signal,
    cache: "no-store" as const
  };
  let response = await fetch(
    `https://api.github.com/repos/${source.github.repository}/releases/assets/${source.github.assetId}`,
    {
      ...options,
      headers: {
        Accept: "application/octet-stream",
        Authorization: authorization,
        "User-Agent": "FOSSBilling Extensions"
      }
    }
  );
  if (response.status === 302) {
    const location = response.headers.get("Location");
    await response.body?.cancel();
    const url = location ? URL.parse(location) : null;
    if (
      !url ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      ![
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com"
      ].includes(url.host)
    ) {
      throw new PackageError(
        "PACKAGE_UNAVAILABLE",
        "GitHub returned an unexpected asset download location",
        503
      );
    }
    response = await fetch(url, options);
  }
  if (
    response.status !== 200 ||
    !response.body ||
    response.headers.get("Content-Type")?.toLowerCase().includes("json")
  ) {
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410)
      throw new PackageError(
        "INVALID_PACKAGE",
        "The GitHub release asset is no longer available",
        422
      );
    throw new PackageError(
      "PACKAGE_UNAVAILABLE",
      "Unable to download the GitHub release asset",
      503
    );
  }
  return response.body;
}
