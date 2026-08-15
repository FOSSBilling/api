# Previews Service

**Base Path:** `/previews/v1`

Read-only lookup of FOSSBilling preview builds. GitHub Actions is the source
of truth for PR/commit previews - `FOSSBilling/FOSSBilling`'s `ci.yml`
uploads one artifact per commit, named `FOSSBilling-preview-{short_sha}.zip`
(`archive: false`, so the zip itself is the artifact - no extra wrapping),
for every PR build, non-main branch push, and main push. This service
resolves by querying that exact name rather than listing every preview
artifact and filtering. The `main` preview's `download_url`/`digest` are
answered from R2 instead, sourced from `digest`/`commit-sha` custom object
metadata the same CI job sets on the R2 upload - kept separate from the
GitHub-artifact path because the R2 zip and the GitHub artifact zip for a
given commit are two independently-built files (a `cp` of the same bytes,
in the current CI job, but not guaranteed to stay that way), so whichever
one is reported as the digest has to match the bytes `main` actually
serves. `GET /main` does still cross-reference that commit's GitHub Actions
artifact for `run_id`/`artifact_id`/`created_at`/`expires_at` - see its
section below - but only as best-effort enrichment, never as a dependency.

There is no publish/write endpoint: nothing pushes data into this service,
it only resolves and redirects.

## Resource model

- `GET /main` and `GET /pr/{number}` are **pointers** - they always resolve
  to whatever is current.
- `GET /commit/{sha}` is a **fixed point** - one commit, one build,
  permanently addressable (until GitHub's artifact retention expires it).
- `pr/{number}`'s handler resolves the PR to its head SHA
  (`GET /pulls/{number}`) and delegates to the same resolver `commit/{sha}`
  uses - one GitHub-facing code path, not two.

## Endpoints

### GET `/main`

Current main preview. `download_url`, `digest`, `commit_sha`,
`size_bytes`, and `last_modified` are sourced from an R2 object HEAD (no
GitHub API call). `run_id`, `artifact_id`, `created_at`, and `expires_at`
are enrichment: resolved from that commit's GitHub Actions artifact (same
lookup `GET /commit/{sha}` uses) purely for shape parity with
`ArtifactPreview`, so a client reading either response doesn't have to
special-case field availability. That enrichment is best-effort and never
load-bearing - if the commit has no known artifact (e.g. it's aged out of
GitHub's 14-day retention) or GitHub is unavailable, those four fields are
just `null`; the response still succeeds with everything R2-sourced intact.

**Response:**

```json
{
  "result": {
    "commit_sha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "short_sha": "a1b2c3d",
    "pr_number": null,
    "run_id": 999999,
    "artifact_id": 555555,
    "created_at": "2026-08-13T10:00:00Z",
    "expires_at": "2026-08-27T10:00:00Z",
    "digest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "size_bytes": 31229553,
    "last_modified": "2026-08-13T13:11:41.000Z",
    "download_url": "https://download.fossbilling.org/FOSSBilling-preview.zip",
    "source": "r2"
  }
}
```

`commit_sha` and `digest` come straight from the R2 object's `commit-sha`/
`digest` custom metadata (`digest` already carries the `sha256:` prefix) -
both are `null` if that object has no custom metadata (e.g. it predates the
CI job setting it), which also means the GitHub Actions enrichment above is
skipped entirely (nothing to look up by). `source` stays `"r2"` regardless
of whether the enrichment resolved - it describes where `download_url`/
`digest` come from, which never changes.

### GET `/main/download`

302 redirect to `download_url` - the same permanent URL `GET /main` already
reports. Exists purely for uniform addressing (every resource under
`/previews/v1` has a `/download` sub-route, so callers never need to
special-case main to reach a download link instead of reading one out of a
JSON body). Unlike `/pr/{number}/download` and `/commit/{sha}/download`,
this target URL is fixed rather than short-lived, so it's answered from the
same cache as `GET /main` instead of re-resolving anything live.

### GET `/pr/{number}` and GET `/commit/{sha}`

Preview build for a pull request's current head, or for one exact commit.
`sha` accepts a full or abbreviated (7+ char) hex SHA.

**Response:**

```json
{
  "result": {
    "commit_sha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "short_sha": "a1b2c3d",
    "pr_number": 123,
    "run_id": 999999,
    "artifact_id": 555555,
    "digest": "sha256:...",
    "size_bytes": 12345,
    "created_at": "2026-08-13T10:00:00Z",
    "expires_at": "2026-08-27T10:00:00Z",
    "download_url": "/previews/v1/commit/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2/download",
    "source": "actions_artifact"
  }
}
```

`digest` is GitHub's own artifact digest - the exact bytes served by the
`/download` route. `pr_number` is only set when resolved via `/pr/{number}`;
a direct `/commit/{sha}` lookup has no way to know which PR (if any) built
that commit, and reports `null`.

`download_url` always points at the canonical `/commit/{sha}/download`
route using the fully-resolved SHA, not `/pr/{number}/download` - a PR's
head SHA moves as new commits land, a specific commit's build does not.

### GET `/pr/{number}/download` and GET `/commit/{sha}/download`

302 redirect to GitHub's live, short-lived artifact download URL. Resolved
fresh on every request - never served from cache, since GitHub's signed URL
expires in about a minute.

## Error Responses

```json
{
  "error": {
    "message": "No pull request #999 was found, or it has no preview build yet.",
    "code": "NOT_FOUND"
  }
}
```

`code` is one of `NOT_FOUND`, `VALIDATION_ERROR` (422, malformed path
param), or GitHub's own `errorCode` (`rate_limit_error`, `auth_error`,
etc., surfaced as 429/503/500 depending on severity).

## Notes

- Responses are cached in `CACHE_KV`, only for successful lookups - a
  not-yet-built PR or a transient GitHub error always re-resolves on the
  next request. `GET /pr/{number}` (`preview:pr:{number}`, also used by
  `/pr/{number}/download` to avoid re-resolving what the metadata route
  already cached) and `GET /main` (`preview:main`) use the 60s default,
  matching how often a moving pointer can realistically change.
  `GET /commit/{sha}` (`preview:commit:{sha}`, likewise shared with
  `/commit/{sha}/download`) uses 3600s instead - a commit's build never
  changes once it exists, so there's no correctness reason to re-check it
  every minute. That 3600s is capped at the artifact's own remaining
  GitHub retention (minus a small safety margin for the cache write
  itself), so a lookup resolved near the end of an artifact's 14-day life
  is never cached longer than the artifact actually exists. Within roughly
  the final minute of that life the capped value falls under KV's 60s
  minimum TTL, so those requests (and any more before the artifact expires
  or a request refreshes it) are just served live instead of cached - a
  short burst of extra GitHub calls right at the end, never stale data.
- `GET /pr/{number}/download` and `GET /commit/{sha}/download` always
  resolve GitHub's signed redirect URL live, never cached - it expires in
  about a minute, and Cloudflare KV's 60s minimum TTL leaves no safe margin
  to cache it without risking handing out an already-expired URL.
- `GITHUB_TOKEN` is required for GitHub API access (shared with
  `versions/v1`).
- `DOWNLOAD_BUCKET` (R2 binding) backs `/main` - see `wrangler.jsonc` for the
  bucket this points at and why.
