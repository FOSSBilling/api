import { Hono } from "hono";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { prettyJSON } from "hono/pretty-json";
import { trimTrailingSlash } from "hono/trailing-slash";
import { compare as semverCompare } from "semver";
import { getReleases } from "../../versions/v1/index";
import { Releases } from "../../versions/v1/interfaces";
import {
  buildSuccessResponse,
  buildUnavailableResponse,
  hasNoReleases
} from "../../versions/v1/responses";
import { StatsData, ReleasesPerYearData } from "./interfaces";
import { STATS_DASHBOARD_HTML } from "./dashboard";
import { getPlatform } from "../../../lib/middleware";
import { ICache } from "../../../lib/interfaces";
import { publicCacheKey, publicResponseCache } from "../../../lib/cache";
import { logError, logInfo } from "../../../lib/logger";
import { GitHubError } from "../../../lib/github-errors";

type StatsEnv = { Bindings: CloudflareBindings };

const STATS_CACHE_KEY = "fossbilling-stats-data";
const STATS_CACHE_NAME = "stats-api-v1";
const STATS_CACHE_CONTROL = "max-age=86400";
const STATS_CACHE_TTL = 86400;

const statsV1 = new Hono<StatsEnv>();

statsV1.use(
  "/*",
  cors({
    origin: "*"
  }),
  trimTrailingSlash()
);

function registerCachedRoute<P extends string>(
  path: P,
  handler: import("hono").Handler<StatsEnv, P>
) {
  return statsV1.get(
    path,
    // Honor conditional requests on cache hits; the inner etag stamps entries.
    etag(),
    publicResponseCache({
      cacheName: STATS_CACHE_NAME,
      cacheControl: STATS_CACHE_CONTROL,
      keyGenerator: publicCacheKey
    }),
    etag(),
    prettyJSON(),
    handler
  );
}

function parseVersionLine(version: string): string {
  const parts = version.split(".");
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}.x`;
  }
  return version;
}

function aggregateStats(releases: Releases): StatsData {
  const versions = Object.keys(releases).sort(semverCompare);

  const releaseSizes = versions.map((version) => ({
    version,
    size_mb:
      Math.round((releases[version].size_bytes / 1024 / 1024) * 100) / 100,
    released_on: releases[version].released_on
  }));

  const phpVersions = versions.map((version) => ({
    version,
    php_version: releases[version].minimum_php_version || "unknown",
    released_on: releases[version].released_on
  }));

  const patchesByVersionLine: Record<string, number> = {};
  versions.forEach((version) => {
    const versionLine = parseVersionLine(version);
    patchesByVersionLine[versionLine] =
      (patchesByVersionLine[versionLine] || 0) + 1;
  });
  const patchesPerRelease = Object.entries(patchesByVersionLine)
    .sort(([a], [b]) => {
      const aNormalized = a.replace(".x", ".0");
      const bNormalized = b.replace(".x", ".0");
      return semverCompare(aNormalized, bNormalized);
    })
    .map(([version_line, patch_count]) => ({
      version_line,
      patch_count
    }));

  const releasesByYear: Record<string, number> = {};
  versions.forEach((version) => {
    if (releases[version].released_on) {
      const year = releases[version].released_on.substring(0, 4);
      releasesByYear[year] = (releasesByYear[year] || 0) + 1;
    }
  });
  const releasesPerYear: ReleasesPerYearData[] = Object.entries(releasesByYear)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, release_count]) => ({
      year,
      release_count
    }));

  return {
    releaseSizes,
    phpVersions,
    patchesPerRelease,
    releasesPerYear
  };
}

async function getStats(
  cache: ICache,
  githubToken: string,
  downloadBucket: R2Bucket,
  waitUntil?: (promise: Promise<unknown>) => void
): Promise<{
  stats: StatsData;
  source: "cache" | "fresh" | "stale";
  error?: GitHubError;
}> {
  // Only the stats value is pre-read here; getReleases does its own read of
  // the shared releases blob. (An earlier version parallelized the two reads
  // and threaded the result through a getReleases parameter; that coupling
  // was removed - the cost is one extra serialized KV round trip on the rare
  // cold-cold path only.)
  const cachedStats = await cache.get(STATS_CACHE_KEY);

  if (cachedStats) {
    try {
      const parsedCache = JSON.parse(cachedStats);
      if (parsedCache && typeof parsedCache === "object") {
        logInfo("stats", "Serving stats from cache", {
          cacheKey: STATS_CACHE_KEY
        });
        return {
          stats: parsedCache as StatsData,
          source: "cache"
        };
      }
    } catch (parseError) {
      logError("stats", "Cache corruption detected, fetching fresh data", {
        cacheKey: STATS_CACHE_KEY,
        error:
          parseError instanceof Error ? parseError.message : String(parseError)
      });
    }
  }

  // getReleases shares its cache with the versions service (same
  // RELEASE_CACHE_KEY), so a fresh fetch here must still resolve R2
  // download_url/digest - otherwise a stats-triggered refresh would
  // overwrite that cache with GitHub-only URLs for up to a day.
  const result = await getReleases(
    cache,
    githubToken,
    downloadBucket,
    false,
    waitUntil
  );

  if (hasNoReleases(result.releases) && result.error) {
    return {
      stats: {
        releaseSizes: [],
        phpVersions: [],
        patchesPerRelease: [],
        releasesPerYear: []
      },
      source: result.source,
      error: result.error
    };
  }

  const stats = aggregateStats(result.releases);

  if (!hasNoReleases(result.releases)) {
    const put = cache.put(STATS_CACHE_KEY, JSON.stringify(stats), {
      expirationTtl: STATS_CACHE_TTL
    });
    if (waitUntil) waitUntil(put);
    else await put;
    logInfo("stats", "Updated stats cache", {
      cacheKey: STATS_CACHE_KEY,
      releaseCount: Object.keys(result.releases).length
    });
  }

  return {
    stats,
    source: result.source as "fresh" | "stale"
  };
}

registerCachedRoute("/data", async (c) => {
  const platform = getPlatform(c);
  const result = await getStats(
    platform.getCache("CACHE_KV"),
    platform.getEnv("GITHUB_TOKEN") || "",
    c.env.DOWNLOAD_BUCKET,
    (p) => c.executionCtx.waitUntil(p)
  );

  if (result.error && result.stats.releaseSizes.length === 0) {
    return c.json(buildUnavailableResponse(result.error), 503);
  }

  return c.json(buildSuccessResponse(result.stats, result.source));
});

registerCachedRoute("/", async (c) => {
  return c.html(STATS_DASHBOARD_HTML);
});

export default statsV1;
