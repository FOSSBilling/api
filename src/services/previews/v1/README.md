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
artifact for enrichment - see Resource Model below - but only as
best-effort, never as a dependency.

There is no publish/write endpoint: nothing pushes data into this service,
it only resolves and redirects.

## Endpoints

Endpoints are not listed here. The service publishes its own contract:

- **OpenAPI document:** `GET /previews/v1/docs/openapi.json`
- **Reference UI:** `GET /previews/v1/docs`

## Resource Model

- `GET /main` and `GET /pr/{number}` are **pointers** - they always resolve
  to whatever is current.
- `GET /commit/{sha}` with a full SHA is a **fixed point** - one commit,
  permanently addressable (until GitHub's artifact retention expires it).
  Abbreviated SHAs (7+ hex characters) are accepted only when a complete
  artifact scan finds one distinct live preview commit. Multiple commits
  return HTTP 409 (`AMBIGUOUS_COMMIT`); use the full SHA to disambiguate.
  An incomplete scan returns 503, never a selected artifact or a 404.
- `pr/{number}`'s handler resolves the PR to its head SHA
  (`GET /pulls/{number}`) and delegates to the same resolver `commit/{sha}`
  uses - one GitHub-facing code path, not two.
- `download_url` differs in kind depending on the resource. `main`'s is the
  permanent public `download.fossbilling.org` URL, embedded directly, since
  it never expires. `pr`/`commit`'s is self-referential - it points back at
  their own `/download` sub-route rather than GitHub's actual signed URL,
  because that URL expires in ~60s and can't be baked into a response with
  any longer cache lifetime; `/download` resolves the real one live on
  each hit.
- `source` on `/main` stays `"r2"` regardless of whether the GitHub Actions
  enrichment below resolves - it describes where `download_url`/`digest`
  come from, which never changes.
- `main`'s `run_id`/`artifact_id`/`created_at`/`expires_at` are enrichment,
  resolved from that commit's GitHub Actions artifact (the same lookup
  `commit/{sha}` uses) purely for shape parity with the PR/commit response,
  so a client reading either doesn't have to special-case field
  availability. It's best-effort and never load-bearing: a miss (no known
  artifact yet, the artifact aged out of GitHub's 14-day retention, GitHub
  unavailable) just leaves those four fields `null` - it's never the reason
  a request to `/main` fails, since `download_url`/`digest` are R2-sourced
  and don't depend on it.

## Notes

- Responses are cached in `CACHE_KV`. Successful lookups are cached as
  described below; `not_found` results are also cached, but only for a
  single 60s KV-floor window - a not-yet-built PR starts resolving within
  a minute of its build landing on GitHub, while polling clients cost one
  KV read instead of the full GitHub resolve chain per poll. `unavailable`
  results (GitHub errors) are never cached - a transient error always
  re-resolves on the next request. `GET /pr/{number}` (`preview:pr:{number}`,
  also used by `/pr/{number}/download` to avoid re-resolving what the
  metadata route already cached) and `GET /main` (`preview:main`) use the
  60s default, matching how often a moving pointer can realistically
  change.
  Full-SHA `GET /commit/{sha}` (`preview:commit:{sha}`, likewise shared with
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
- Abbreviated commit lookups bypass KV reads and writes, including legacy
  prefix entries: a newly built colliding commit must be detected on the
  next lookup. Concurrent prefix lookups share the in-flight scan, but its
  result is never retained. Full-SHA cache behavior is unchanged.
- `GET /pr/{number}/download` and `GET /commit/{sha}/download` always
  resolve GitHub's signed redirect URL live, never cached - it expires in
  about a minute, and Cloudflare KV's 60s minimum TTL leaves no safe margin
  to cache it without risking handing out an already-expired URL.
- `GITHUB_TOKEN` is required for GitHub API access (shared with
  `versions/v1`).
- `DOWNLOAD_BUCKET` (R2 binding) backs `/main` - see `wrangler.jsonc` for the
  bucket this points at and why.

### GitHub request budgets

Every previews GitHub request reserves a token from the singleton
`PREVIEW_GITHUB_BUDGET` Durable Object before contacting GitHub. This includes
fallback pages, PR head lookups, live download redirects and main enrichment.
Metadata cache hits and R2 downloads spend no tokens. All locations and lookup
keys share a token bucket with a 60-call burst and a refill of 1000 calls/hour.
Each client shares a second bucket with a 12-call burst and 120 calls/hour
refill, so one client cannot spend the whole global burst. IPv4 addresses use
one allowance per address; IPv6 addresses share an allowance per /64, with
IPv4-mapped IPv6 addresses using their IPv4 allowance. Only a SHA-256 digest of
this normalized identity from Cloudflare's connecting IP is stored. Missing or
invalid addresses share one allowance. Idle client buckets expire after 30 minutes.

Each incoming request also has an eight-call ceiling shared across PR head
resolution, artifact fallback, main enrichment and live download resolution.
Exhausting this ceiling returns unavailable rather than a false not-found result.
A match beyond the ceiling requires a cheaper lookup (such as a full commit SHA)
or a later cached result; repeating a cold lookup does not resume its scan.

Abbreviated SHAs and fork-PR resolution remain supported within these budgets.
Exhaustion or budget-service failure stops before another GitHub request and
returns the existing unavailable (503) response, without negative caching an
incomplete lookup. Main enrichment remains optional. These caps bound preview
consumption, rather than guaranteeing remaining quota when other token consumers
are busy. Raising them requires reviewing the shared token's quota allocation.

The binding and SQLite class migration in `wrangler.jsonc` are required when
deploying this change; do not deploy only the application source.
