# Extensions v2

**Base Path:** `/extensions/v2`

Self-service extension publishing, developer-profile ownership, moderation, and browsing published extensions.

This service owns the complete Extensions domain and its `DB_EXTENSIONS` schema. The separate Extensions site keeps OIDC/session state but reaches this domain through the generated HTTPS API client; it must not bind or migrate `DB_EXTENSIONS`.

## Endpoints

Endpoints are not listed here. The service publishes its own contract:

- **OpenAPI document:** `GET /extensions/v2/docs/openapi.json`
- **Reference UI:** `GET /extensions/v2/docs`

## Manifest contract

New v2 writes use the [FOSSBilling manifest v1 fields](https://github.com/FOSSBilling/modules/blob/main/manifest.schema.json): `manifest_version: 1`, `type: "module"` (replacing `mod`; standalone `hook` entries require manual reclassification), `author: {name, url?}`, a string `license`, optional `homepage_url` (replacing `website`), and `requires: {fossbilling, php, modules?}`. IDs allow lowercase letters, digits, underscores, and hyphens, up to 64 characters. Names are limited to 100 characters, descriptions to 500, and versions use SemVer without a `v` prefix.

`icon_url` is an optional path relative to the package root, as in `icon.svg`; it cannot be an absolute URL, absolute path, or contain `..` or backslashes. Consumers resolve package assets against their trusted distribution source. Historical icons may still be absolute URLs.

API publishing fields `readme`, `source`, `download_url`, and `releases` remain alongside the manifest metadata. Each release carries its own `requires` object instead of `min_fossbilling_version`. Constraints are retained verbatim, including Composer ranges and module dependencies; package CI remains responsible for semantic constraint/license validation and confirming that icon files exist. The API adds size bounds to metadata (author names: 200 characters; license and requirement strings: 1,000; URLs and icon paths: 2,048).

`requires.fossbilling` is mandatory. `requires.php` is an optional additional restriction: when omitted, FOSSBilling’s PHP requirements apply; when supplied, both the core and extension constraints must be satisfied.

`author` is package attribution. `developer` identifies the authenticated owner and remains controlled by the API; an author field never grants ownership.

Run the read-only `db/manifest-preflight.sql` query before deployment. It reports extension IDs and zero-based release indexes needing manual correction.

Migration `0029` fills a missing `requires.fossbilling` from the legacy minimum as a `>=` constraint, preserving existing PHP and module constraints. It also adds verified PHP constraints from the BTCPay 0.1.3–0.1.5 and OpenReceive 0.4.29 packages. Explicitly invalid values require correction using verified package metadata.

Migration `0029_align_manifest.sql` stops with `manifest_data_requires_manual_correction` if the preflight reports issues, rolling back the entire migration. Correct those rows and retry. Once prepared, it converts `mod` to `module`, converts legacy license objects to strings (using `spdx_id`, otherwise `name`), copies the current release's requirements and the developer's attribution, and removes obsolete release minimum fields. Physical `website` storage remains for v1 compatibility. Reviewed and pending revision bodies retain their original audit content; old pending revisions must be resubmitted using the new contract before approval. Published reads expect canonical storage; historical audit reads remain separate.

For example, after checking an affected package's actual requirements, an operator can add `requires` to one release without rewriting its remaining fields:

```sql
UPDATE extensions
SET releases = json_set(releases, '$[0].requires',
  json('{"fossbilling":">=0.8.9","php":">=8.3"}'))
WHERE id = 'affected-extension';
```

Use the ID, index, and verified constraints from the preflight investigation; the values above are examples. Re-run the query until it returns no rows.

For imported collections already over a retained-resource quota, the direct update above will be rejected because it grows stored content. Add the reviewed, ID-scoped correction statements at `-- MANUAL_MANIFEST_CORRECTIONS` in migration `0029` instead. This section runs inside D1's atomic migration transaction after the growth gate is temporarily relaxed, while byte-accounting triggers stay active. Preflight then validates the corrected library before backfill; an error rolls back every correction and schema change. The normal growth gate is restored before commit. With this path, the external preflight report will still list the uncorrected rows until execution; the migration reruns preflight after applying the reviewed corrections. Do not lower usage counters or leave production triggers disabled to force an update through.

After applying the prepared migration, run the read-only `db/resource-inventory.sql` reconciliation query. It must return no discrepancies; investigate any returned subjects before reopening writes. The migration regression test covers correction of an over-quota collection, rollback when issues remain, restored quota enforcement, and reconciled byte totals.

Apply the migration and API deployment in a controlled cutover: the old Worker expects object licenses, while the new Worker requires the added metadata column.

This changes the v2 request/response contract: regenerate the Extensions site's client and update CI publishers together with the API rollout. The modules publisher must stop translating `module` to `mod` and send the manifest fields directly. Package-relative icons use v1's empty-string fallback. The v1 adapter continues to return `mod`, `website`, object licenses, and minimum release versions; constraints are converted to their earliest matching SemVer version. A malformed, unsatisfiable, or Composer-only constraint with no representable v1 minimum produces an explicit error identifying the release for manual correction; it is never replaced with `0.0.0`.

The frontend revalidation tags are `extensions` and `developers`, shared with the Extensions site. Deploy the API and site tag change together. New code calls `revalidateExtensions(c)`.

## Lifecycle

An extension exists from `POST /extensions`, not from approval. There is no separate submission record.

- `POST /extensions` creates the record and reserves its id. It stays out of public listings until its first revision is approved.
- `PUT /extensions/{id}` proposes an edit. Published content is unchanged until approval. One unreviewed revision per extension at a time.
- `PUT /extensions/{id}/revisions/{revisionId}` lets the active owner replace that pending revision; see [Editing a pending submission](#editing-a-pending-submission).
- `DELETE /extensions/{id}` withdraws an unpublished extension and releases its id. Published extensions cannot be withdrawn by owners.
- `POST /extensions/{id}/revisions/{revisionId}/approve` publishes. `reject` leaves published content untouched.
- `POST /extensions/{id}/delist` (moderator-only) hides a published extension for cause without deleting content or history. `POST /extensions/{id}/relist` restores it. Both accept `?notify=false`.
- `POST /extensions/{id}/moderator-correct` (moderator-only) fixes live extension content corruption without waiting for the author. Writes an already-approved revision, leaves `published_at` and ownership untouched. Requires a published, listed extension with no pending revision (409 otherwise). No `?notify` option and no author email; the fix is recorded in revision history.

An edit cannot rename an extension or move it to another developer. A user owns at most one developer profile, so no request body names one.

### Editing a pending submission

`PUT /extensions/{id}/revisions/{revisionId}` replaces pending content using the same body as `PUT /extensions/{id}`. Only an active human owner can call it, including for publisher-created submissions. The replacement records that owner as `submitted_by` and counts toward their pending-revision and write limits.

The response is `202` with a new `revision_id` and the extension's canonical `id` casing. The supplied revision must still be pending at the current ownership epoch. A stale or reviewed revision returns `409`; refresh before retrying.

Deletion and insertion run in one transaction: a failed write keeps the original pending revision. The new ID prevents stale edits or moderator decisions from applying to the replacement. Published content and reviewed history stay unchanged.

## Reads

`GET /extensions/{id}` and `GET /developers/{id}` are role-aware: anonymous callers get the published projection; owners and moderators get the full object. For extensions, 404 hides drafts and delisted rows.

`GET /extensions?scope=` selects the projection:

- `public` (default, anonymous allowed): published extension cards.
- `mine`: caller's own extensions.
- `all` (moderator only): every extension, filterable by `status` (`published`, `delisted`, `unpublished`) and `q` (case-insensitive id substring).

Owner/moderator extension reads return four independent fields, not a derived status:

| `published` | `pending_revision` | `last_review` | Meaning                             |
| ----------- | ------------------ | ------------- | ----------------------------------- |
| `null`      | set                | `null`        | Awaiting first review               |
| `null`      | set                | rejected      | Rejected, already resubmitted       |
| `null`      | `null`             | rejected      | Rejected; edit and resubmit         |
| set         | `null`             | approved      | Live, no unreviewed edit            |
| set         | `null`             | `null`        | Live, adopted from pre-v2 directory |
| set         | set                | either        | Live, edit awaiting review          |

`delisted` is orthogonal to all three: it hides the row from public reads without touching them. Adopted rows have no revisions; a live extension with no review history is normal.

`GET /extensions/{id}/revisions` lists one extension's history (owner/moderator, newest first). `GET /revisions` is the global review queue (moderator only, `?status=` defaults to `pending`, oldest first). `GET /developers?scope=` (`all` default, `unapproved` for the queue; `?status=` stays as a deprecated alias and 422s when it disagrees with `?scope=`) and `GET /developers/claims?scope=` (`mine`, `pending`) follow the same pattern. `PATCH /users/me` returns the full account projection, like `GET /users/me`.

Anonymous detail reads are cacheable (`Cache-Control: public`); detail reads that vary by caller send `Vary: Authorization`.

## Pagination

All v2 lists use opaque keyset cursors: `?limit=` (1–100, default 50) with `?cursor=` from the previous page's `pagination.next_cursor`. Envelope is always `pagination: {next_cursor, has_more}`. An invalid cursor returns `INVALID_CURSOR` (422); restart from the first page. List items omit `readme`, `releases`, and `requires`; fetch `GET /extensions/{id}` for detail.

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

## Machine publishing

Machine clients (CI publishers) authenticate with short-lived access tokens from the central auth service's `client_credentials` grant, bound to this API via RFC 8707 `resource=https://api.fossbilling.net`. Tokens are RFC 9068 JWTs (`typ: at+jwt`, EdDSA) carrying `client_id` and `scope`; verification is local via the issuer's JWKS (`M2M_*` variables, root README), so revocation takes effect at token expiry (10 minutes).

Two scopes gate the machine surface: `extensions:push` covers `POST /extensions` and `PUT /extensions/{id}`; `extensions:publish` additionally covers approving a pending revision on the mapped developer's own extension — the one carve-out from moderator-only approval. Machine tokens are answered 403 on account, moderator, and ownership routes; on public reads they are served the anonymous projection. Bindings are bound to the developer's ownership epoch at registration, so an ownership transfer goes stale and a moderator must re-register before the client writes again.

A moderator binds a client to a developer profile with `PUT /m2m/clients/{client_id}` (`developer_id`, `can_publish`), lists bindings with `GET /m2m/clients`, and revokes with `DELETE /m2m/clients/{client_id}`. A revoked client's tokens still verify but fail authorization on the next write. Each binding also creates a synthetic internal user (`m2m:<client_id>`) that anchors revision foreign keys; it is not an account and cannot sign in.

Submissions made by a client are recorded under that synthetic user, and its auto-approvals are stamped `[auto publisher=<client_id>]` in the revision's `review_note`. Write pacing keys machine traffic by `client_id`; per-developer content budgets apply unchanged.

Provisioning spans both repos: create the client and its scopes/resource link in the auth service (see its operations README), then register the mapping here.

## Public badges

`GET /extensions/v2/extensions/{id}/badges/{type}` returns a public SVG. Types are `version` (latest release tag), `fossbilling` (that release's full `requires.fossbilling` string), and `license` (package license). Requirements are displayed unchanged, including upper bounds, exclusions, and compound ranges.

For example: `/extensions/v2/extensions/branding/badges/fossbilling?color=green`. The optional `color` accepts badge-maker colors, up to 100 characters. Badges are cached for five minutes in browsers and one hour at the CDN, matching v1.

Missing, unpublished, and delisted extensions return 404. Invalid types or query values return 422; unusable stored badge fields return 409 for manual correction. With no releases, version and requirement badges show `unknown`; license badges still work.

Existing v1 badge URLs and minimum-version output are unchanged. Use v2 for new embeds that need the full requirement.

## Ownership verification

For organization developer IDs, GitHub membership auto-verifies only against a valid, unexpired membership snapshot. A fresh snapshot without the org is a confirmed mismatch. Missing, malformed, or expired evidence is inconclusive: the profile stays unapproved and claims stay pending for manual review. `github_org_verified` absent or `null` is a review signal, not proof.

## Notification emails

Revision approve/reject, delist/relist, developer approve, and claim approve/reject email the affected author unless the moderator passes `?notify=false`. Bot decisions use the same path, marked with an `[auto policy=…]` `review_note` prefix.

Recipients: developer `contact_email`, falling back to the owning account's email; claim decisions go to the claimant's account email. Sending is best-effort via `waitUntil` and never fails the write; the result carries `notified: boolean`. See `email/` for the provider abstraction (`mxroute`, `resend`, `disabled`) and the root README for `EXTENSIONS_V2_EMAIL_*`.

## Limits and budgets

Content writes (`POST /extensions`, `PUT /extensions/{id}`, moderator-correct) count the raw request stream before JSON parsing. Raw limit is **512 KiB** (`413 BODY_TOO_LARGE`); normalized JSON content limit is **256 KiB**. New slug ids are at most 64 characters.

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

| Failure                                       | Meaning                                                 |
| --------------------------------------------- | ------------------------------------------------------- |
| `extension_ids_must_not_differ_only_by_case`  | Two ids collide under `idx_extensions_id_nocase`        |
| `extension_references_must_resolve`           | An extension names a developer id with no developer row |
| `submissions_must_name_an_existing_developer` | A submission names a developer id with no developer row |
| `submission_target_ids_must_not_be_reserved`  | A submission targets a reserved static-route id         |

Reconcile and re-run; the migration touches nothing before these checks.

## Code layout

See `AGENTS.md` for `routes/`, `db/`, `schemas/`, `github/`, and `middleware.ts`. This service is the reference layout for larger services.
