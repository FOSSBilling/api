import { Hono } from "hono";
import { cache } from "hono/cache";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { prettyJSON } from "hono/pretty-json";
import { trimTrailingSlash } from "hono/trailing-slash";
import { compare as semverCompare } from "semver";
import { getReleases } from "../../versions/v1/index";
import { Releases } from "../../versions/v1/interfaces";
import { StatsData, ReleasesPerYearData } from "./interfaces";
import { getPlatform } from "../../../lib/middleware";
import { ICache } from "../../../lib/interfaces";
import { publicCacheKey } from "../../../lib/cache";
import { logError, logInfo } from "../../../lib/logger";
import { GitHubError } from "../../../lib/github-errors";

type StatsEnv = { Bindings: CloudflareBindings };

const STATS_CACHE_KEY = "fossbilling-stats-data";
const STATS_CACHE_NAME = "stats-api-v1";
const STATS_CACHE_CONTROL = "max-age: 86400";
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
    cache({
      cacheName: STATS_CACHE_NAME,
      cacheControl: STATS_CACHE_CONTROL,
      keyGenerator: publicCacheKey
    }),
    etag(),
    prettyJSON(),
    handler
  );
}

function hasNoReleases(releases: Releases): boolean {
  return Object.keys(releases).length === 0;
}

function buildSuccessResponse<T>(
  result: T,
  source: "cache" | "fresh" | "stale"
) {
  return {
    result,
    error_code: 0,
    message: null,
    stale: source === "stale"
  };
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
  updateCache: boolean = false
): Promise<{
  stats: StatsData;
  source: "cache" | "fresh" | "stale";
  error?: GitHubError;
}> {
  const cachedStats = await cache.get(STATS_CACHE_KEY);

  if (cachedStats && !updateCache) {
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

  const result = await getReleases(cache, githubToken, updateCache);

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
    await cache.put(STATS_CACHE_KEY, JSON.stringify(stats), {
      expirationTtl: STATS_CACHE_TTL
    });
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
    platform.getEnv("GITHUB_TOKEN") || ""
  );

  if (result.error && result.stats.releaseSizes.length === 0) {
    return c.json(buildUnavailableResponse(result.error), 503);
  }

  return c.json(buildSuccessResponse(result.stats, result.source));
});

registerCachedRoute("/", async (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FOSSBilling Release Statistics</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js" integrity="sha256-SERKgtTty1vsDxll+qzd4Y2cF9swY9BCq62i9wXJ9Uo=" crossorigin="anonymous"></script>

    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f7fa;
            color: #2c3e50;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        h1 {
            text-align: center;
            color: #34495e;
            margin-bottom: 30px;
        }
        .charts-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(600px, 1fr));
            gap: 30px;
            margin-bottom: 30px;
        }
        .chart-container {
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .chart-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 15px;
            color: #34495e;
        }
        canvas {
            max-height: 400px;
        }
        .loading {
            text-align: center;
            padding: 40px;
            font-size: 18px;
            color: #7f8c8d;
        }
        .error {
            text-align: center;
            padding: 40px;
            font-size: 18px;
            color: #e74c3c;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>FOSSBilling Release Statistics</h1>
        <div id="loading" class="loading">Loading statistics...</div>
        <div id="error" class="error" style="display: none;"></div>
        <div id="charts" style="display: none;">
            <div class="charts-grid">
                <div class="chart-container">
                    <div class="chart-title">Release Size Over Time (MB)</div>
                    <canvas id="releaseSizeChart" aria-label="Chart showing release size over time in megabytes"></canvas>
                </div>
                <div class="chart-container">
                    <div class="chart-title">PHP Version Requirements</div>
                    <canvas id="phpVersionChart" aria-label="Chart showing PHP version requirements for releases"></canvas>
                </div>
            </div>
            <div class="charts-grid">
                <div class="chart-container">
                    <div class="chart-title">Patches Per Release (0.6.x, 0.5.x, etc.)</div>
                    <canvas id="patchesChart" aria-label="Chart showing number of patches per release series such as 0.6.x and 0.5.x"></canvas>
                </div>
                <div class="chart-container">
                    <div class="chart-title">Releases Per Year</div>
                    <canvas id="releasesPerYearChart" aria-label="Chart showing number of FOSSBilling releases per year"></canvas>
                </div>
            </div>
        </div>
    </div>

    <script>
        let charts = {};
        
        function showLoading() {
            document.getElementById('loading').style.display = 'block';
            document.getElementById('error').style.display = 'none';
            document.getElementById('charts').style.display = 'none';
        }
        
        function showError(message) {
            document.getElementById('loading').style.display = 'none';
            document.getElementById('error').textContent = message;
            document.getElementById('error').style.display = 'block';
            document.getElementById('charts').style.display = 'none';
        }
        
        function showCharts() {
            document.getElementById('loading').style.display = 'none';
            document.getElementById('error').style.display = 'none';
            document.getElementById('charts').style.display = 'block';
        }
        
        function parsePhpVersion(phpVersion) {
            if (!phpVersion || phpVersion === 'unknown') return 0;
            const match = phpVersion.match(/(\\d+\\.\\d+)/);
            return match ? parseFloat(match[1]) : 0;
        }
        
        function createReleaseSizeChart(data) {
            const ctx = document.getElementById('releaseSizeChart').getContext('2d');
            const sortedData = data.releaseSizes.sort((a, b) => 
                new Date(a.released_on) - new Date(b.released_on)
            );
            
            if (charts.releaseSize) {
                charts.releaseSize.destroy();
            }
            
            charts.releaseSize = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: sortedData.map(d => d.version),
                    datasets: [{
                        label: 'Size (MB)',
                        data: sortedData.map(d => d.size_mb),
                        borderColor: '#3498db',
                        backgroundColor: 'rgba(52, 152, 219, 0.1)',
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top'
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Size (MB)'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Version'
                            }
                        }
                    }
                }
            });
        }
        
        function createPhpVersionChart(data) {
            const ctx = document.getElementById('phpVersionChart').getContext('2d');
            const sortedData = data.phpVersions.sort((a, b) => 
                new Date(a.released_on) - new Date(b.released_on)
            ).filter(d => d.php_version && d.php_version !== 'unknown');
            
            if (charts.phpVersion) {
                charts.phpVersion.destroy();
            }
            
            charts.phpVersion = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: sortedData.map(d => d.version),
                    datasets: [{
                        label: 'Minimum PHP Version',
                        data: sortedData.map(d => parsePhpVersion(d.php_version)),
                        borderColor: '#e74c3c',
                        backgroundColor: 'rgba(231, 76, 60, 0.1)',
                        fill: false,
                        tension: 0.4,
                        pointRadius: 4,
                        pointHoverRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top'
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: false,
                            min: 7.0,
                            max: 8.5,
                            ticks: {
                                stepSize: 0.1,
                                callback: function(value) {
                                    return 'PHP ' + value.toFixed(1);
                                }
                            },
                            title: {
                                display: true,
                                text: 'PHP Version'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'FOSSBilling Version'
                            }
                        }
                    }
                }
            });
        }
        
        function createPatchesChart(data) {
            const ctx = document.getElementById('patchesChart').getContext('2d');
            
            if (charts.patches) {
                charts.patches.destroy();
            }
            
            charts.patches = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: data.patchesPerRelease.map(d => d.version_line),
                    datasets: [{
                        label: 'Number of Patches',
                        data: data.patchesPerRelease.map(d => d.patch_count),
                        backgroundColor: '#2ecc71',
                        borderColor: '#27ae60',
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top'
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Number of Patches'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Version'
                            }
                        }
                    }
                }
            });
        }
        
        function createReleasesPerYearChart(data) {
            const ctx = document.getElementById('releasesPerYearChart').getContext('2d');
            
            if (charts.releasesPerYear) {
                charts.releasesPerYear.destroy();
            }
            
            charts.releasesPerYear = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: data.releasesPerYear.map(d => d.year),
                    datasets: [{
                        label: 'Number of Releases',
                        data: data.releasesPerYear.map(d => d.release_count),
                        backgroundColor: '#f39c12',
                        borderColor: '#d35400',
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top'
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Number of Releases'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Year'
                            }
                        }
                    }
                }
            });
        }
        
        async function loadStats() {
            showLoading();
            
            try {
                const statsUrl = window.location.origin + '/stats/v1/data';
                const response = await fetch(statsUrl);
                
                if (!response.ok) {
                    throw new Error('Failed to load statistics');
                }
                
                const data = await response.json();
                
                if (data.error_code !== 0) {
                    throw new Error(data.message || 'Unknown error');
                }
                
                const stats = data.result;
                
                if (!stats || stats.releaseSizes.length === 0) {
                    throw new Error('No statistics available');
                }
                
                createReleaseSizeChart(stats);
                createPhpVersionChart(stats);
                createPatchesChart(stats);
                createReleasesPerYearChart(stats);
                
                showCharts();
            } catch (error) {
                showError('Error loading statistics: ' + error.message);
            }
        }
        
        // Load stats on page load
        window.addEventListener('load', loadStats);
    </script>
</body>
</html>`;

  return c.html(html);
});

export default statsV1;
