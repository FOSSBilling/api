# Versions Service

**Base Path:** `/versions/v1`

Provides release metadata from the FOSSBilling GitHub repo. Responses are cached in `CACHE_KV` for 24 hours.

## Authentication

`/update` requires a bearer token stored in `AUTH_KV` under `UPDATE_TOKEN`.

## Endpoints

### GET `/`

Returns all available releases.

**Request:**

```http
GET /versions/v1
```

**Response:**

```json
{
  "result": {
    "0.6.0": {
      "version": "0.6.0",
      "released_on": "2023-04-01T00:00:00Z",
      "minimum_php_version": "8.1",
      "download_url": "https://download.fossbilling.org/releases/0.6.0/FOSSBilling-0.6.0.zip",
      "size_bytes": 15485760,
      "is_prerelease": false,
      "github_release_id": 987654321,
      "changelog": "## 0.6.0\n- New features...",
      "digest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    }
  },
  "error_code": 0,
  "message": null,
  "stale": false
}
```

### GET `/:version`

Get details for a specific release. Use `latest` for the newest release.

**Request:**

```http
GET /versions/v1/0.6.0
GET /versions/v1/latest
```

**Response:** Uses the same envelope as the `GET /` response (`result`, `error_code`, `message`, `stale`), but `result` contains a single version object (the same schema as a value from the `GET /` `result` map).

### GET `/build_changelog/:current`

Returns a combined changelog for all releases greater than `:current` (in semantic version order).

**Request:**

```http
GET /versions/v1/build_changelog/0.5.0
```

**Response:**

```json
{
  "result": "## 0.6.0\n- New features...\n\n## 0.5.5\n- Bug fixes...",
  "error_code": 0,
  "message": null,
  "stale": false
}
```

### GET `/count`

Returns the total count of available releases.

**Request:**

```http
GET /versions/v1/count
```

**Response:**

```json
{
  "result": 51,
  "error_code": 0,
  "message": null,
  "stale": false
}
```

### GET `/update`

Refreshes the cached release data. Requires bearer auth.

**Request:**

```http
GET /versions/v1/update
Authorization: Bearer YOUR_UPDATE_TOKEN
```

## Error Responses

When a version is not found:

```json
{
  "result": null,
  "error_code": 404,
  "message": "FOSSBilling version 0.999.0 does not appear to exist."
}
```

When GitHub is unavailable and no cached data exists:

```json
{
  "result": null,
  "error_code": 503,
  "message": "Unable to fetch releases and no cached data available",
  "details": {
    "http_status": 403,
    "error_code": "rate_limit_error"
  }
}
```

## Notes

- All responses include a `stale` field that is `true` when cached data is served after a failed fetch.
- `details` includes the GitHub HTTP status and error code when available.
- `GITHUB_TOKEN` is required for GitHub API access.
- `DOWNLOAD_BUCKET` (R2 binding, shared with `previews/v1`) backs `download_url`/`digest` below.
- Releases before 0.5.0 read `src/composer.json`; newer releases use `composer.json`.
- `download_url` is `download.fossbilling.org` when the release has been mirrored to R2 and the requesting client's own version trusts that host (see `Update::$allowedDownloadPrefixes` in FOSSBilling/FOSSBilling) - github.com has no AAAA record, so IPv6-only hosts can't reach a GitHub asset URL. It falls back to the GitHub asset URL otherwise. Mirroring began at 0.8.0, so releases before that are never looked up in R2 at all.
- `digest` is the SHA-256 digest of the release zip (`sha256:<hex>`). It's read from the R2 object's metadata when mirrored (set by CI from the exact uploaded file); otherwise it's GitHub's asset digest, or `null` if GitHub hasn't computed one.
