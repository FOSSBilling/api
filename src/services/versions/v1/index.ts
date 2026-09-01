import { bearerAuth } from "hono/bearer-auth";
import { Hono, type Context, type Handler } from "hono";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { prettyJSON } from "hono/pretty-json";
import { graphql } from "@octokit/graphql";
import { request as ghRequest } from "@octokit/request";
import { trimTrailingSlash } from "hono/trailing-slash";
import {
  compare as semverCompare,
  gt as semverGt,
  gte as semverGte,
  valid as semverValid
} from "semver";
import { Releases, ReleaseDetails, ResolvedReleaseDetails } from "./interfaces";
import { getReleaseR2Object } from "./r2";
import { getPlatform } from "../../../lib/middleware";
import { ICache } from "../../../lib/interfaces";
import { logError, logWarn, logInfo } from "../../../lib/logger";
import {
  GitHubError,
  AuthError,
  RateLimitError,
  ValidationError,
  classifyGitHubError,
  getMostCriticalError
} from "../../../lib/github-errors";

const REPO_OWNER = "FOSSBilling";
const REPO_NAME = "FOSSBilling";
const RELEASE_CACHE_KEY = "gh-fossbilling-releases";
const RELEASES_CACHE_CONTROL = "max-age: 86400";
const RELEASE_CACHE_TTL = 86400;
const RELEASES_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases`;
type VersionsEnv = { Bindings: CloudflareBindings };

const UPDATE_TOKEN_CACHE_TTL_MS = 60_000;

let updateTokenCache: { token: string; expiresAt: number } | null = null;

const versionsV1 = new Hono<VersionsEnv>();

versionsV1.use(
  "/*",
  cors({
    origin: "*"
  }),
  trimTrailingSlash()
);

async function getUpdateToken(cache: ICache): Promise<string> {
  if (updateTokenCache && updateTokenCache.expiresAt > Date.now()) {
    return updateTokenCache.token;
  }

  const token = await cache.get("UPDATE_TOKEN");

  if (!token) {
    throw new Error("UPDATE_TOKEN not found in AUTH_KV storage");
  }

  updateTokenCache = {
    token,
    expiresAt: Date.now() + UPDATE_TOKEN_CACHE_TTL_MS
  };

  return token;
}

function registerCachedRoute<P extends string>(
  path: P,
  handler: Handler<VersionsEnv, P>
) {
  return versionsV1.get(
    path,
    async (c, next) => {
      c.header("Cache-Control", RELEASES_CACHE_CONTROL);
      return next();
    },
    etag(),
    prettyJSON(),
    handler
  );
}

async function loadReleases(
  c: Context<VersionsEnv>,
  updateCache: boolean = false
): Promise<GetReleasesResult> {
  const platform = getPlatform(c);
  return getReleases(
    platform.getCache("CACHE_KV"),
    platform.getEnv("GITHUB_TOKEN") || "",
    c.env.DOWNLOAD_BUCKET,
    updateCache
  );
}

function hasNoReleases(releases: Releases): boolean {
  return Object.keys(releases).length === 0;
}

function buildUnavailableResponse(error: GitHubError) {
  return {
    result: null,
    error_code: 503,
    message: "Unable to fetch releases and no cached data available",
    details: {
      http_status: error.httpStatus,
      error_code: error.errorCode
    }
  };
}

function buildSuccessResponse<T>(
  result: T,
  source: GetReleasesResult["source"]
) {
  return {
    result,
    error_code: 0,
    message: null,
    stale: source === "stale"
  };
}

// FOSSBilling's own Update.php sends this on every request already (src/di.php,
// added in 0.8.4), so no client change is needed to gate the R2 mirror by version.
// Anything we can't confidently read a trusted version out of - no header at all
// (<=0.8.3, which predates this header), or a version we don't recognize - falls
// through to `false`, matching the fully-backward-compatible default in
// resolveReleaseForClient() below.
const USER_AGENT_VERSION_PATTERN = /^FOSSBilling\/(.+)$/;

// First version whose Update::$allowedDownloadPrefixes trusts
// download.fossbilling.org. Older clients reject that URL outright with
// "Update canceled for security reasons" - see FOSSBilling/FOSSBilling
// incident following #4255/#2479.
const MIRROR_TRUST_MIN_VERSION = "0.8.7";

function clientTrustsMirror(userAgent: string | undefined | null): boolean {
  if (!userAgent) return false;

  const match = userAgent.match(USER_AGENT_VERSION_PATTERN);
  if (!match) return false;

  const version = match[1];
  if (!semverValid(version)) return false;

  return semverGte(version, MIRROR_TRUST_MIN_VERSION);
}

// Resolves a release's dual (GitHub + optional R2 mirror) download info down to
// the single URL/digest pair this specific requester should be sent, and drops
// the internal-only mirror_* fields from the public response shape.
function resolveReleaseForClient(
  release: ReleaseDetails,
  userAgent: string | undefined | null
): ResolvedReleaseDetails {
  const {
    mirror_download_url: mirrorDownloadUrl,
    mirror_digest: mirrorDigest,
    ...resolved
  } = release;

  if (mirrorDownloadUrl !== null && clientTrustsMirror(userAgent)) {
    resolved.download_url = mirrorDownloadUrl;
    resolved.digest = mirrorDigest;
  }

  return resolved;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest: string | null;
}

function getReleaseZipAsset(
  assets: ReleaseAsset[],
  tag: string
): ReleaseAsset | undefined {
  return assets.find(
    (asset) =>
      asset.name === "FOSSBilling.zip" ||
      asset.name === `FOSSBilling-${tag}.zip`
  );
}

registerCachedRoute("/", async (c) => {
  const result = await loadReleases(c);
  const releases = result.releases;

  if (hasNoReleases(releases) && result.error) {
    return c.json(buildUnavailableResponse(result.error), 503);
  }

  if (hasNoReleases(releases)) {
    c.header("Vary", "*");
  } else {
    c.header("Vary", "User-Agent");
  }

  const userAgent = c.req.header("User-Agent");
  const resolvedReleases = Object.fromEntries(
    Object.entries(releases).map(([tag, release]) => [
      tag,
      resolveReleaseForClient(release, userAgent)
    ])
  );

  return c.json(buildSuccessResponse(resolvedReleases, result.source));
});

versionsV1.get(
  "/update",
  async (c, next) => {
    c.header("Cache-Control", "no-store");
    return next();
  },
  async (c, next) => {
    const platform = getPlatform(c);
    const token = await getUpdateToken(platform.getCache("AUTH_KV"));
    const bearer = bearerAuth<VersionsEnv>({ token });
    return bearer(c, next);
  },
  async (c) => {
    const platform = getPlatform(c);
    const result = await getReleases(
      platform.getCache("CACHE_KV"),
      platform.getEnv("GITHUB_TOKEN") || "",
      c.env.DOWNLOAD_BUCKET,
      true
    );
    const releaseCount = Object.keys(result.releases).length;

    if (result.error && releaseCount === 0) {
      return c.json(
        {
          result: null,
          error_code: 500,
          message: `Failed to fetch releases: ${result.error.message}`,
          details: {
            http_status: result.error.httpStatus,
            error_code: result.error.errorCode
          },
          stale: result.source === "stale"
        },
        500
      );
    }

    if (result.error) {
      return c.json({
        result: `Releases cache updated with ${releaseCount} releases (some errors occurred).`,
        error_code: 0,
        message: result.error.message,
        warning: result.error.message,
        details: {
          http_status: result.error.httpStatus,
          error_code: result.error.errorCode
        },
        stale: result.source === "stale"
      });
    }

    return c.json({
      result: `Releases cache updated successfully with ${releaseCount} releases.`,
      error_code: 0,
      message: null,
      warning: null,
      stale: false
    });
  }
);

registerCachedRoute("/build_changelog/:current", async (c) => {
  const current = c.req.param("current");
  const result = await loadReleases(c);

  const releases = result.releases;

  if (hasNoReleases(releases) && result.error) {
    return c.json(buildUnavailableResponse(result.error), 503);
  }

  if (!current || !semverValid(current)) {
    c.status(400);
    return c.json({
      result: null,
      error_code: 400,
      message: `'${current}' is not a valid semantic version.`
    });
  }

  const sortedReleaseKeys = Object.keys(releases).sort((a, b) =>
    semverCompare(b, a)
  );
  const completedChangelog: string[] = [];

  for (const version of sortedReleaseKeys) {
    if (semverGt(version, current)) {
      let changelog = releases[version].changelog;

      if (!changelog) {
        changelog = `## ${version}\n`;
        changelog += "The changelogs for this release appear to be missing.";
      }

      completedChangelog.push(changelog);
    } else {
      break;
    }
  }

  const assembledChangelog = completedChangelog.join("\n");

  return c.json(buildSuccessResponse(assembledChangelog, result.source));
});

registerCachedRoute("/count", async (c) => {
  const result = await loadReleases(c);

  const releases = result.releases;
  const releaseCount = Object.keys(releases).length;

  if (releaseCount === 0 && result.error) {
    return c.json(buildUnavailableResponse(result.error), 503);
  }

  return c.json(buildSuccessResponse(releaseCount, result.source));
});

registerCachedRoute("/:version", async (c) => {
  const version = c.req.param("version");
  let result = await loadReleases(c);

  if (!version) {
    c.status(400);
    return c.json({
      result: null,
      error_code: 400,
      message: "Version parameter is required."
    });
  }

  let releases = result.releases;

  if (hasNoReleases(releases)) {
    result = await loadReleases(c, true);
    releases = result.releases;
  }

  if (hasNoReleases(releases) && result.error) {
    return c.json(buildUnavailableResponse(result.error), 503);
  }

  if (hasNoReleases(releases)) {
    c.status(404);
    return c.json({
      result: null,
      error_code: 404,
      message:
        "No releases are currently available. Please try again later or check the GitHub releases page."
    });
  }

  c.header("Vary", "User-Agent");
  const userAgent = c.req.header("User-Agent");

  if (version === "latest") {
    const sortedKeys = Object.keys(releases).sort(semverCompare);
    const lastKey = sortedKeys.at(-1);
    const resolved = lastKey
      ? resolveReleaseForClient(releases[lastKey], userAgent)
      : null;

    return c.json(buildSuccessResponse(resolved, result.source));
  }

  if (version in releases) {
    return c.json(
      buildSuccessResponse(
        resolveReleaseForClient(releases[version], userAgent),
        result.source
      )
    );
  }

  c.status(404);
  return c.json({
    result: null,
    error_code: 404,
    message: `FOSSBilling version ${version} does not appear to exist.`
  });
});

export default versionsV1;

interface GetReleasesResult {
  releases: Releases;
  source: "cache" | "fresh" | "stale";
  error?: GitHubError;
}

export function resetUpdateTokenCache() {
  updateTokenCache = null;
}

export async function getReleases(
  cache: ICache,
  githubToken: string,
  downloadBucket: R2Bucket,
  updateCache: boolean = false
): Promise<GetReleasesResult> {
  const cachedReleases = await cache.get(RELEASE_CACHE_KEY);

  if (cachedReleases && !updateCache) {
    const parsedCache = parseCachedReleases(
      cachedReleases,
      "Cache corruption detected, attempting fresh fetch"
    );
    if (parsedCache) {
      logInfo("versions", "Serving releases from cache", {
        cacheKey: RELEASE_CACHE_KEY
      });
      return {
        releases: parsedCache,
        source: "cache"
      };
    }
  }

  try {
    const result = await ghRequest("GET /repos/{owner}/{repo}/releases", {
      owner: REPO_OWNER,
      repo: REPO_NAME,
      headers: {
        Authorization: `Bearer ${githubToken}`
      },
      per_page: 100
    });

    if (!Array.isArray(result.data)) {
      logWarn("versions", "Unexpected GitHub releases response format", {
        responseType: typeof result.data
      });
      return {
        releases: {},
        source: "fresh"
      };
    }

    logInfo("versions", "Successfully fetched releases from GitHub API", {
      url: RELEASES_URL,
      releaseCount: result.data.length
    });

    const errors: GitHubError[] = [];

    // Reuse PHP versions already stored in cache to avoid a subrequest per release.
    // Only releases absent from the existing cache require a fresh fetch.
    const existingReleases = cachedReleases
      ? parseCachedReleases(
          cachedReleases,
          "Failed to parse existing cache during update"
        )
      : null;

    type ProcessedRelease = {
      tag: string;
      release: (typeof result.data)[number];
      zipAsset: ReleaseAsset;
      cachedPhpVersion: string | undefined;
    };

    const releasesToProcess: ProcessedRelease[] = [];
    const releasesToFetch: PhpVersionBatchItem[] = [];

    for (const release of result.data) {
      const tag = release.tag_name;
      if (!semverValid(tag)) {
        logWarn("versions", "Skipping release with invalid semver tag", {
          tag,
          releaseId: release.id
        });
        continue;
      }

      const zipAsset = getReleaseZipAsset(release.assets, tag);
      if (!zipAsset) {
        continue;
      }

      const cachedPhpVersion = existingReleases?.[tag]?.minimum_php_version;
      const cachedPhpVersionValue =
        typeof cachedPhpVersion === "string" && cachedPhpVersion.trim() !== ""
          ? cachedPhpVersion
          : undefined;
      releasesToProcess.push({
        tag,
        release,
        zipAsset,
        cachedPhpVersion: cachedPhpVersionValue
      });

      if (cachedPhpVersionValue === undefined) {
        const composerPath = semverGte(tag, "0.5.0")
          ? "composer.json"
          : "src/composer.json";
        releasesToFetch.push({ tag, composerPath });
      }
    }

    // Single GraphQL request to fetch all missing PHP versions in one subrequest.
    let batchPhpVersions = new Map<string, string>();
    if (releasesToFetch.length > 0) {
      try {
        batchPhpVersions = await getBatchPhpVersions(
          githubToken,
          releasesToFetch
        );
        logInfo("versions", "Batch fetched PHP versions via GraphQL", {
          requested: releasesToFetch.length,
          resolved: batchPhpVersions.size
        });
      } catch (batchError) {
        const githubError = classifyGitHubError(
          batchError,
          "https://api.github.com/graphql"
        );
        errors.push(githubError);
        logWarn("versions", "Failed to batch fetch PHP versions", {
          message: githubError.message,
          count: releasesToFetch.length
        });
      }
    }

    // Record both the GitHub asset and the R2 mirror (if this release has
    // one) rather than resolving to a single download_url here - which of
    // the two a given client should actually be sent depends on whether
    // *that client's own version* trusts download.fossbilling.org, and is
    // decided per-request in resolveReleaseForClient().
    const releaseEntries: [string, ReleaseDetails][] = await Promise.all(
      releasesToProcess.map(
        async ({ tag, release, zipAsset, cachedPhpVersion }) => {
          const phpVersion =
            cachedPhpVersion !== undefined
              ? cachedPhpVersion
              : (batchPhpVersions.get(tag) ?? "");

          let r2Object = null;
          try {
            r2Object = await getReleaseR2Object(downloadBucket, tag);
          } catch (r2Error) {
            logWarn("versions", "Failed to look up release in R2", {
              tag,
              error:
                r2Error instanceof Error ? r2Error.message : String(r2Error)
            });
          }

          const releaseDetails: ReleaseDetails = {
            version: release.name || tag,
            released_on: release.published_at ?? "",
            minimum_php_version: phpVersion,
            download_url: zipAsset.browser_download_url,
            mirror_download_url: r2Object?.downloadUrl ?? null,
            size_bytes: zipAsset.size,
            is_prerelease: Boolean(release.prerelease),
            github_release_id: release.id ?? 0,
            changelog: release.body || "",
            digest: zipAsset.digest ?? null,
            mirror_digest: r2Object?.digest ?? null
          };
          return [tag, releaseDetails];
        }
      )
    );

    const sortedReleases = Object.fromEntries(
      releaseEntries.sort((a, b) => semverCompare(b[0], a[0]))
    );
    const releases = sortedReleases;

    if (Object.keys(releases).length > 0) {
      await cache.put(RELEASE_CACHE_KEY, JSON.stringify(releases), {
        expirationTtl: RELEASE_CACHE_TTL
      });
      logInfo("versions", "Updated releases cache", {
        cacheKey: RELEASE_CACHE_KEY,
        releaseCount: Object.keys(releases).length
      });
    }

    const mostCriticalError = getMostCriticalError(errors) || undefined;

    return {
      releases,
      source: "fresh",
      error:
        mostCriticalError instanceof ValidationError
          ? undefined
          : mostCriticalError
    };
  } catch (error) {
    const githubError = classifyGitHubError(error, RELEASES_URL);

    if (githubError instanceof ValidationError) {
      logWarn("versions", "Invalid response received from GitHub API", {
        message: githubError.message,
        url: githubError.url
      });
      return {
        releases: {},
        source: "fresh"
      };
    }

    if (
      githubError instanceof AuthError ||
      githubError instanceof RateLimitError
    ) {
      logError("versions", "Critical GitHub API error", {
        message: githubError.message,
        httpStatus: githubError.httpStatus,
        url: githubError.url
      });
    } else {
      logWarn("versions", "GitHub API error", {
        message: githubError.message,
        httpStatus: githubError.httpStatus,
        url: githubError.url
      });
    }

    if (cachedReleases) {
      const parsedCache = parseCachedReleases(
        cachedReleases,
        "Cache corruption detected"
      );
      if (parsedCache) {
        logInfo("versions", "Serving stale releases from cache", {
          cacheKey: RELEASE_CACHE_KEY,
          reason: githubError.message
        });
        return {
          releases: parsedCache,
          source: "stale",
          error: githubError
        };
      }
      return {
        releases: {},
        source: "fresh",
        error: githubError
      };
    }

    return {
      releases: {},
      source: "fresh",
      error: githubError
    };
  }
}

function parseCachedReleases(
  cachedReleases: string,
  logMessage: string
): Releases | null {
  try {
    const parsedCache = JSON.parse(cachedReleases);
    if (parsedCache && typeof parsedCache === "object") {
      // Cache entries written before the `digest` field existed lack the
      // key entirely; normalize them to the documented `null` fallback.
      for (const release of Object.values(parsedCache as Releases)) {
        if (release.digest === undefined) {
          release.digest = null;
        }

        // A release missing *either* mirror field predates them (both are
        // always written together - see getReleases() below - so a partial
        // pair means this entry is malformed or from before they existed),
        // which includes the window when download_url itself was written
        // as the (unconditionally preferred) R2 mirror URL, with no
        // separate field preserving the GitHub URL every older client
        // trusts. There's no `null` to backfill that repairs it: the
        // GitHub URL isn't recoverable from this cache entry at all, and
        // serving download_url as-is risks handing every client - not
        // just old ones - the untrusted mirror URL. A one-sided pair is
        // just as unsafe: resolveReleaseForClient() would pair a real
        // mirror_download_url with an undefined mirror_digest (or vice
        // versa) for a trusting client, and JSON drops that undefined key
        // from the response entirely - incomplete update metadata. Invalidate
        // the whole cache so getReleases() falls through to a fresh fetch,
        // which rebuilds every entry with its GitHub and mirror URLs kept
        // separate again.
        if (
          release.mirror_download_url === undefined ||
          release.mirror_digest === undefined
        ) {
          logWarn(
            "versions",
            "Cache entry predates mirror fields; invalidating cache to rebuild with separated URLs",
            { cacheKey: RELEASE_CACHE_KEY, version: release.version }
          );
          return null;
        }
      }
      return parsedCache as Releases;
    }
  } catch (parseError) {
    logError("versions", logMessage, {
      cacheKey: RELEASE_CACHE_KEY,
      error:
        parseError instanceof Error ? parseError.message : String(parseError)
    });
  }

  return null;
}

interface PhpVersionBatchItem {
  tag: string;
  composerPath: string;
}

async function getBatchPhpVersions(
  githubToken: string,
  releases: PhpVersionBatchItem[]
): Promise<Map<string, string>> {
  if (releases.length === 0) return new Map();

  const fields = releases
    .map(
      ({ tag, composerPath }, i) =>
        `r${i}: object(expression: "${tag}:${composerPath}") { ... on Blob { text } }`
    )
    .join("\n");

  const query = `{ repository(owner: "${REPO_OWNER}", name: "${REPO_NAME}") {\n${fields}\n} }`;

  const data = await graphql<{
    repository: Record<string, { text?: string } | null>;
  }>(query, {
    headers: { authorization: `Bearer ${githubToken}` }
  });

  const result = new Map<string, string>();

  for (let i = 0; i < releases.length; i++) {
    const { tag } = releases[i];
    const blob = data.repository[`r${i}`];
    if (blob?.text) {
      try {
        const composerJson = JSON.parse(blob.text) as {
          require?: { php?: string };
        };
        const phpRequirement = composerJson.require?.php;
        if (phpRequirement) {
          result.set(tag, phpRequirement.replace(/\^|>=/g, "").trim());
        }
      } catch {
        // Ignore individual parse errors
      }
    }
  }

  return result;
}
