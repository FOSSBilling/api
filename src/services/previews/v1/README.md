# Previews Service

**Base Path:** `/previews/v1`

Read-only lookup of FOSSBilling preview builds. GitHub Actions is the source
of truth for PR/commit previews - `FOSSBilling/FOSSBilling`'s `ci.yml`
already uploads a single unified artifact (`FOSSBilling Preview`) for every
PR build, non-main branch push, and main push, and this service resolves
against that artifact list rather than maintaining its own registry. The
`main` preview is answered from R2 instead, because the R2-hosted zip and
the GitHub artifact zip for the same commit are two independently-built byte
streams with different digests - whichever one is reported has to match the
bytes actually served.

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

Current main preview, sourced from an R2 object HEAD (no GitHub API call).

**Response:**

```json
{
  "result": {
    "commit_sha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "short_sha": "a1b2c3d",
    "digest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "size_bytes": 31229553,
    "last_modified": "2026-08-13T13:11:41.000Z",
    "download_url": "https://download.fossbilling.org/FOSSBilling-preview.zip",
    "source": "r2"
  }
}
```

`commit_sha` and `digest` are `null` until FOSSBilling/FOSSBilling's
`upload-preview` CI job is updated to set `sha256`/`commit-sha` as R2 custom
object metadata on the upload - see that repo's `ci.yml`.

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
{ "error": { "message": "No pull request #999 was found, or it has no preview build yet.", "code": "NOT_FOUND" } }
```

`code` is one of `NOT_FOUND`, `VALIDATION_ERROR` (422, malformed path
param), or GitHub's own `errorCode` (`rate_limit_error`, `auth_error`,
etc., surfaced as 429/503/500 depending on severity).

## Notes

- `GET /pr/{number}` and `GET /commit/{sha}` responses are cached in
  `CACHE_KV` for 60 seconds (`preview:pr:{number}` / `preview:commit:{sha}`);
  `GET /main` for 60 seconds (`preview:main`). Only successful lookups are
  cached - a not-yet-built PR or a transient GitHub error always re-resolves
  on the next request.
- `GITHUB_TOKEN` is required for GitHub API access (shared with
  `versions/v1`).
- `PREVIEW_BUCKET` (R2 binding) backs `/main` - see `wrangler.jsonc` for the
  bucket this points at and why.
