# Extensions v2

**Base Path:** `/extensions/v2`

Self-service extension publishing, developer-profile ownership, moderation, and public catalogue browsing.

This service owns the complete Extensions domain and its `DB_EXTENSIONS` schema. The separate Extensions site keeps OIDC/session state but reaches this domain through the generated HTTPS API client; it must not bind or migrate `DB_EXTENSIONS`.

## Endpoints

Endpoints are not listed here. The service publishes its own contract:

- **OpenAPI document:** `GET /extensions/v2/docs/openapi.json`
- **Reference UI:** `GET /extensions/v2/docs`

## Lifecycle

An extension exists from `POST /extensions`, not from approval. There is no separate submission record.

- `POST /extensions` creates the record and reserves its id. It stays out of catalogues until its first revision is approved.
- `PUT /extensions/{id}` proposes an edit. Published content is unchanged until approval. One unreviewed revision per extension at a time.
- `DELETE /extensions/{id}` withdraws an unpublished extension and releases its id. Published extensions cannot be withdrawn by owners.
- `POST /extensions/{id}/revisions/{revisionId}/approve` publishes. `reject` leaves published content untouched.
- `POST /extensions/{id}/delist` (moderator-only) hides a published extension for cause without deleting content or history. `POST /extensions/{id}/relist` restores it. Both accept `?notify=false`.
- `POST /extensions/{id}/moderator-correct` (moderator-only) fixes live catalogue corruption without waiting for the author. Writes an already-approved revision, leaves `published_at` and ownership untouched. Requires a published, listed extension with no pending revision (409 otherwise). No `?notify` option and no author email; the fix is recorded in revision history.

An edit cannot rename an extension or move it to another developer. A user owns at most one developer profile, so no request body names one.

## Reads

`GET /extensions/{id}` and `GET /developers/{id}` are role-aware: anonymous callers get the published projection; owners and moderators get the full object. For extensions, 404 hides drafts and delisted rows.

`GET /extensions?scope=` selects the projection:

- `public` (default, anonymous allowed): published catalogue cards.
- `mine`: caller's own extensions.
- `all` (moderator only): every extension, filterable by `status` (`published`, `delisted`, `unpublished`) and `q` (case-insensitive id substring).

Owner/moderator extension reads return four independent fields, not a derived status:

| `published` | `pending_revision` | `last_review` | Meaning                             |
| ----------- | ------------------ | ------------- | ----------------------------------- |
| `null`      | set                | `null`        | Awaiting first review               |
| `null`      | set                | rejected      | Rejected, already resubmitted       |
| `null`      | `null`             | rejected      | Rejected; edit and resubmit         |
| set         | `null`             | approved      | Live, no unreviewed edit            |
| set         | `null`             | `null`        | Live, adopted from pre-v2 catalogue |
| set         | set                | either        | Live, edit awaiting review          |

`delisted` is orthogonal to all three: it hides the row from public reads without touching them. Adopted rows have no revisions; a live extension with no review history is normal.

`GET /extensions/{id}/revisions` lists one extension's history (owner/moderator, newest first). `GET /revisions` is the global review queue (moderator only, `?status=` defaults to `pending`, oldest first). `GET /developers?scope=` (`all` default, `unapproved` for the queue; `?status=` stays as a deprecated alias and 422s when it disagrees with `?scope=`) and `GET /developers/claims?scope=` (`mine`, `pending`) follow the same pattern. `PATCH /users/me` returns the full account projection, like `GET /users/me`.

Anonymous detail reads are cacheable (`Cache-Control: public`); detail reads that vary by caller send `Vary: Authorization`.

## Pagination

All v2 lists use opaque keyset cursors: `?limit=` (1–100, default 50) with `?cursor=` from the previous page's `pagination.next_cursor`. Envelope is always `pagination: {next_cursor, has_more}`. An invalid cursor returns `INVALID_CURSOR` (422); restart from the first page. List items omit `readme` and `releases`; fetch `GET /extensions/{id}` for detail.

## Authentication

Requests carry a short-lived bearer assertion minted by the Extensions site, verified here with `ASSERTION_SIGNING_SECRET` (see root README).

Assertions use HS256 with issuer `fossbilling-extensions`, audience `fossbilling-api/extensions-v2`, purpose `user-authentication`, protocol version `1`. Valid for at most 60 seconds.

`PUT /users/me/identity` requires purpose `identity-sync` plus a `body_sha256` claim holding the lowercase hex SHA-256 of the exact UTF-8 JSON request bytes. The site must hash the same bytes it sends. Identity proofs return 403 on other routes; missing/invalid credentials return 401; schema failures return 422. Membership expiry is capped at one hour.

### Rotating the shared secret

`ASSERTION_SIGNING_SECRET_PREVIOUS` is accepted only as a temporary rotation window:

1. Set the API's `ASSERTION_SIGNING_SECRET_PREVIOUS` to the current value.
2. Replace the API's active `ASSERTION_SIGNING_SECRET`.
3. Replace the Extensions site's active secret.
4. After at least 65 seconds, verify traffic and remove the previous secret.

## Ownership verification

For organization developer IDs, GitHub membership auto-verifies only against a valid, unexpired membership snapshot. A fresh snapshot without the org is a confirmed mismatch. Missing, malformed, or expired evidence is inconclusive: the profile stays unapproved and claims stay pending for manual review. `github_org_verified` absent or `null` is a review signal, not proof.

## Notification emails

Revision approve/reject, delist/relist, developer approve, and claim approve/reject email the affected author unless the moderator passes `?notify=false`. Bot decisions use the same path, marked with an `[auto policy=…]` `review_note` prefix.

Recipients: developer `contact_email`, falling back to the owning account's email; claim decisions go to the claimant's account email. Sending is best-effort via `waitUntil` and never fails the write; the result carries `notified: boolean`. See `email/` for the provider abstraction (`mxroute`, `resend`, `disabled`) and the root README for `EXTENSIONS_V2_EMAIL_*`.

## Limits and budgets

Request size is counted on the raw stream before JSON parsing. Raw limit is **512 KiB** (`413 BODY_TOO_LARGE`); normalized JSON content limit is **256 KiB**. New slug ids are at most 200 characters.

`EXTENSION_WRITE_RATE_LIMITER` paces IP and account attempts at 60/minute, including validation failures. It is approximate edge pacing, not the durable quota. Missing pacing fails closed (`503 ADMISSION_UNAVAILABLE`).

Migration `0026_resource_bounds.sql` enforces accepted-write and retained-resource limits inside the write transaction:

| Resource                              | Account | Developer |
| ------------------------------------- | ------- | --------- |
| Accepted revisions per rolling minute | 5       | 5         |
| Accepted revisions per rolling day    | 50      | 50        |
| Retained content bytes                | 25 MiB  | 25 MiB    |
| Extension records                     | 100     | 100       |
| Revision metadata records             | 1,000   | 1,000     |

Minute/day exhaustion returns `429` (`WRITE_RATE_MINUTE` / `WRITE_RATE_DAY`, `Retry-After` 60 / 86400). Retained quota exhaustion returns `409 RESOURCE_QUOTA`. Withdrawing an unpublished extension releases stored bytes and record counts, not accepted-write allowance. Pending budget: ten revisions per submitter, one per extension. See `resource-limits.ts` for the mirrored policy values.

Claim verification is budgeted before contacting GitHub: 3 attempts per account and per developer id per 60 seconds, plus 300 aggregate attempts per hour (migration `0024`). Exhaustion returns `429 RATE_LIMITED`. Mismatches and upstream failures do not refund attempts.

`PUT /developers/me` allows 20 successful writes per account per rolling 24 hours (migration `0025`). Exhaustion returns `429 PROFILE_MUTATION_RATE_LIMITED` with `Retry-After: 86400`. Identical submissions preserve approval and skip the write.

Profile approval binds to the reviewed revision: owner/moderator reads include `profile_generation` and `content_revision`; `POST /developers/{id}/approve` requires both as `expected_generation` / `expected_revision` (migration `0027`). Changed profiles return 409; missing/invalid tokens return 422. Every meaningful edit clears manual approval.

## Revisions and retention

`GET /revisions` and `GET /extensions/{id}/revisions` return summaries (`name`, `version`, `description`, decision metadata, `content_bytes`, `content_available`, `content_hash`, `compacted_at`), never content bodies. Fetch `GET /extensions/{id}/revisions/{revisionId}` for full content (owner/moderator). A compacted revision returns `content: null` with its hash and timestamp. Oversized legacy bodies return `409 CONTENT_UNAVAILABLE`; their summaries report `content_available: false`.

Scheduled maintenance runs hourly, handling at most 20 bodies and 500 expired ledger rows per run. Retention defaults to `dry-run` (report only); only `EXTENSIONS_RETENTION_MODE=compact` compacts reviewed bodies older than 180 days to `{}`. Pending bodies and the published revision are always protected. Inventory totals are logged after each run. `db/resource-inventory.sql` is a manual read-only reconciliation query.

## Database

Uses D1 binding `DB_EXTENSIONS`, shared with v1 (read-only there). This service owns the schema. Apply migrations only from this repository with `npm run db:migrate:extensions-v2:local` / `:remote`.

- `0020`: guard check; fails if an adopted developer id shadows a static route (`me`/`claims`/`unapproved`).
- `0021`: rebuilds `extensions`, replaces `extension_submissions` with `extension_revisions`. Ordering is load-bearing (never drop a table with children); covered by `migrations.test.ts`. Refuses unmigratable data with named checks:

| Failure                                      | Meaning                                          |
| -------------------------------------------- | ------------------------------------------------ |
| `extension_ids_must_not_differ_only_by_case` | Two ids collide under `idx_extensions_id_nocase` |
| `submission_target_ids_must_not_be_reserved` | A submission targets a reserved static-route id  |
| `extension_references_must_resolve`          | Rebuild would carry a dangling reference through |

Reconcile and re-run; the migration touches nothing before these checks.

## Code layout

See `AGENTS.md` for `routes/`, `db/`, `schemas/`, `github/`, and `middleware.ts`. This service is the reference layout for larger services.
