import { z } from "zod";
import { publicGitHubToken } from "../../../../lib/github-app";
import type { PlatformContext } from "../../../../lib/context";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import { PACKAGE_LIMITS } from "@fossbilling/extension-packaging/limits";
import { boundedBytes } from "@fossbilling/extension-packaging/store";
import {
  GitHubPackageSourceSchema,
  type GitHubPackageSource
} from "@fossbilling/extension-packaging/processor";

const releaseSchema = z.object({
  draft: z.literal(false),
  assets: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      size: z.number().int().nonnegative(),
      state: z.string(),
      digest: z.string().nullish()
    })
  )
});

function releasePath(value: string) {
  const invalid = () =>
    new PackageError(
      "INVALID_PACKAGE",
      "Use a public ZIP asset URL from a specific GitHub release",
      422
    );
  const url = URL.parse(value);
  if (!url) throw invalid();
  const match =
    /^\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/releases\/download\/(.+)\/([^/]+)$/u.exec(
      url.pathname
    );
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  )
    throw invalid();
  try {
    const tag = decodeURIComponent(match[2]);
    const name = decodeURIComponent(match[3]);
    if (
      tag === "." ||
      tag === ".." ||
      !/\.zip$/iu.test(name) ||
      name.includes("/")
    )
      throw invalid();
    return { repository: match[1].toLowerCase(), tag, name };
  } catch {
    throw invalid();
  }
}

export async function resolveGitHubPackageAsset(
  value: string,
  platform: Pick<PlatformContext, "getEnv">
): Promise<GitHubPackageSource> {
  const { repository, tag, name } = releasePath(value);
  const token = await publicGitHubToken(platform).catch(() => {
    throw new PackageError(
      "PACKAGE_UNAVAILABLE",
      "GitHub authentication is temporarily unavailable. Please try again.",
      503
    );
  });
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "FOSSBilling Extensions"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10000)
    }
  );
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404)
      throw new PackageError(
        "INVALID_PACKAGE",
        "That public GitHub release was not found",
        422
      );
    throw new PackageError(
      "PACKAGE_UNAVAILABLE",
      "Unable to read the GitHub release. Please try again.",
      503
    );
  }
  const bytes = await boundedBytes(response.body, 2 * 1024 * 1024);
  const release = releaseSchema.parse(
    JSON.parse(new TextDecoder().decode(bytes))
  );
  const asset = release.assets.find(
    (item) => item.name === name && item.state === "uploaded"
  );
  if (!asset)
    throw new PackageError(
      "INVALID_PACKAGE",
      "That GitHub release has no attached ZIP with this name",
      422
    );
  if (!asset.size)
    throw new PackageError(
      "INVALID_PACKAGE",
      "That GitHub release ZIP is empty",
      422
    );
  if (asset.size > PACKAGE_LIMITS.sourceBytes)
    throw new PackageError("BODY_TOO_LARGE", "Source ZIP exceeds 5 MiB", 413);
  if (!asset.digest || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest))
    throw new PackageError(
      "INVALID_PACKAGE",
      "GitHub does not provide a SHA-256 for this asset. Upload the ZIP instead.",
      422
    );
  return GitHubPackageSourceSchema.parse({
    github: { repository, assetId: asset.id, bytes: asset.size },
    sha256: asset.digest.slice(7)
  });
}
