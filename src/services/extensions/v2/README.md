# Extensions v2

**Base Path:** `/extensions/v2`

Self-service extension publishing, developer-profile ownership, moderation, and public catalogue browsing.

This service owns the complete Extensions domain and its `DB_EXTENSIONS` schema: users, developers, submissions, claims, transfers, history, and catalogue data. The separate Extensions site keeps OIDC/session state but reaches this domain through the generated HTTPS API client; it must not bind or migrate `DB_EXTENSIONS`.

## Endpoints

Endpoints are not listed here. The service publishes its own contract:

- **OpenAPI document:** `GET /extensions/v2/docs/openapi.json`
- **Reference UI:** `GET /extensions/v2/docs`

## The Extension Lifecycle

An extension is a resource from the moment a developer creates it, not from the
moment a moderator approves it. There is no separate "submission" to reconcile
against it.

- `POST /extensions` creates the record. It holds its id immediately and stays
  out of both catalogues until its first revision is approved.
- `PUT /extensions/{id}` proposes an edit. The published content does not
  change until a moderator approves the revision, and only one revision per
  extension may be unreviewed at a time.
- `DELETE /extensions/{id}` withdraws an extension that has never been
  published, releasing its id. A published extension cannot be withdrawn by its
  owner — consumers pin the id.
- `POST /extensions/{id}/revisions/{revisionId}/approve` publishes the
  revision's content. `reject` leaves the published content untouched and the
  extension available to edit and resubmit.
- `POST /extensions/{id}/delist` pulls an already-published extension out of
  the public catalogue for cause (its upstream source disappearing, for
  example). Moderator-only, and the inverse of neither `approve` nor
  `reject`: content and history are kept, so the owner can still see and edit
  the extension. `POST /extensions/{id}/relist` restores it (optional
  `review_note`, same `?notify` opt-out); see `ExtensionsDatabase.delist()`
  and `relist()`.
- `GET /extensions/{id}` is role-aware: anonymous and unrelated callers get
  the published projection (or 404, which hides existence for drafts and
  delisted rows); the owner and moderators get the full `OwnedExtension`,
  including `delisted`. This replaces the former `GET /extensions/mine/{id}`
  and `GET /moderation/extensions/{id}` pair, which shared that shape.
- `GET /extensions?scope=` lists catalogue cards or owned rows:
  `scope=public` (default, anonymous allowed) is the published catalogue;
  `scope=mine` is the caller's own extensions (empty page when they have no
  developer profile); `scope=all` (moderator only) is every extension,
  filterable by `status` (`published`, `delisted`, `unpublished`) and `q`
  (case-insensitive id substring). Replaces `GET /extensions/mine` and
  `GET /moderation/all-extensions`. An extension's own status and its having
  a pending edit are independent.

### Moderation Notification Emails

Revision approve/reject, delist/relist, developer approve, and claim
approve/reject email the affected author unless the moderator opts out with
`?notify=false`. Automatic decisions by the FOSSBilling Bot account use the
same routes and mail path; they are identified by the `[auto policy=…]`
`review_note` prefix (no schema change).
The recipient is the developer's `contact_email`, falling back to the owning
account's `email`; claim decisions go to the claimant's account email.
Sending is best-effort and never fails the write: the result carries
`notified: boolean`, which reports whether a recipient was resolved and the
send dispatched. The provider POST itself runs via `waitUntil` after the
response (it has a 10s abort timeout and is not worth blocking a moderation
write on), so delivery failures surface only in logs. A missing address or
missing mail credentials skip the send before the response and report
`notified: false`. See `email/` for the provider abstraction (`mxroute` via
`https://smtpapi.mxroute.com/`, `resend`, or `disabled`) and the root README
for the `EXTENSIONS_V2_EMAIL_*` configuration.

The id and the developer are properties of the extension, not of a revision: an
edit cannot rename an extension or move it to another developer, and approving
one no longer rewrites the developer profile as a side effect. A user owns at
most one developer profile, so no request body names one.

### Reading Owner State

`GET /extensions?scope=mine` and `GET /extensions/{id}` (as owner/moderator)
return four independent fields rather than a single derived status, because
together they are the state and a derived enum could only disagree with them. The table below
covers three of them - `published`, `pending_revision` and `last_review` - the
fourth, `delisted`, is documented separately just below since it is orthogonal
to all three:

| `published` | `pending_revision` | `last_review` | Meaning                                 |
| ----------- | ------------------ | ------------- | --------------------------------------- |
| `null`      | set                | `null`        | Awaiting first review                   |
| `null`      | set                | rejected      | Rejected, and already resubmitted       |
| `null`      | `null`             | rejected      | Rejected; edit and resubmit             |
| set         | `null`             | approved      | Live, no unreviewed edit                |
| set         | `null`             | `null`        | Live, adopted from the pre-v2 catalogue |
| set         | set                | either        | Live, with an edit awaiting review      |

The adopted row is the one worth reading twice: migration 0021 published every
extension that already existed, and those have no revisions at all, so a live
extension with no review history is normal rather than a gap. `published`
being set is the only thing that means "in the catalogue" - except a fourth,
independent field, `delisted`: set once a moderator removes a published
extension for cause, it hides the row from both public catalogue reads
without touching `published`, `pending_revision` or `last_review`.

Merged reads return a union narrowed by the request: `?scope=` selects the
list projection explicitly, while `GET /extensions/{id}` and
`GET /developers/{id}` return the published/public shape anonymously and the
owned/full shape for the owner or a moderator (for extensions, 404 otherwise
hides draft and delisted rows).
Anonymous reads stay cacheable (`Cache-Control: public`); authenticated reads
send `Vary: Authorization`.

`GET /extensions/{id}/revisions` lists the full history of one extension,
newest first, for its owner or any moderator. `GET /revisions` is the global
review queue (moderator only, `?status=` defaulting to `pending`, oldest
first).

`GET /developers?scope=` (`all` default, `unapproved` for the review queue;
`?status=` remains as a deprecated alias during the coordinated migration and
422s when it disagrees with `?scope=`) replaces `GET /developers/unapproved`.
`GET /developers/claims?scope=mine` (the caller's claims) and `?scope=pending`
(moderator queue) replace `GET /developers/claims/mine` and
`GET /developers/claims`; both return the enriched pending shape, and a
`status` filter disagreeing with `scope=pending` is rejected with 422 rather
than silently ignored. `GET /developers/{id}` is role-aware like
`GET /extensions/{id}`: public view anonymously, full view for the owner or a
moderator. `PATCH /users/me` returns the full account projection, like
`GET /users/me`.

`GET /developers`, `GET /developers/claims`, and `GET /developers/{id}/history`
page by opaque keyset cursor like every other v2 list: `?limit=` (1-100,
default 50) with `?cursor=` carried from the previous page's
`pagination.next_cursor`. An invalid cursor is rejected with `INVALID_CURSOR`
(422); the response envelope is always `pagination: {next_cursor, has_more}`.

## Authentication

Requests carry a short-lived bearer assertion minted by the Extensions site and verified here with a shared HMAC secret (`ASSERTION_SIGNING_SECRET`; see the root README for where to configure it).

Assertions use HS256 and include the exact issuer `fossbilling-extensions`, audience `fossbilling-api/extensions-v2`, purpose `user-authentication`, and protocol version `1`. They are valid for at most 60 seconds.

### Rotating the Shared Secret

`ASSERTION_SIGNING_SECRET_PREVIOUS` is an optional second secret accepted only as a temporary rotation window. To rotate without interrupting requests:

1. Set the API's `ASSERTION_SIGNING_SECRET_PREVIOUS` to the current value.
2. Replace the API's active `ASSERTION_SIGNING_SECRET`.
3. Replace the Extensions site's active secret.
4. After at least 65 seconds, verify requests and remove the API's previous secret.

Remove the previous secret once the new one has been active for at least 65 seconds and all in-flight assertions have expired.

## Ownership Verification

For organization developer IDs, GitHub membership is used for automatic verification only when the API has a valid, unexpired membership snapshot. A fresh snapshot that does not contain the organization remains a confirmed mismatch and is rejected. Missing, malformed, or expired evidence is inconclusive instead: a new profile remains unapproved and a claim remains pending for manual moderator review. Moderators must verify ownership through their normal out-of-band process before approving either workflow.

`github_org_verified` being absent or `null` is a review signal, not proof of ownership or an authorization grant. Consumers and moderation tooling must not treat an inconclusive result as verified.

## List Pagination

`GET /extensions/v2/extensions` returns bounded pages. `scope=public` (default)
returns lightweight published catalogue items, `scope=mine`/`all` return owned
rows. List items intentionally omit `readme` and `releases`; retrieve the full object from `GET /extensions/v2/extensions/{id}` for detail views. Follow `pagination.next_cursor` by passing it unchanged as `cursor`, and treat cursors as opaque. The default page size is 50 and `limit` may be set from 1 through 100.

Cursors carry a version field and are validated on decode, so a cursor from an older format is rejected with `INVALID_CURSOR` (HTTP 422) rather than being misread. Clients should treat that as "restart pagination from the first page", not as an error to surface.

## Database

Uses the D1 binding `DB_EXTENSIONS`, shared with v1 (read-only there). This service owns the schema and the migrations.

`extensions` holds the record; its content columns are the _published_
projection and are NULL until a first approval, with `published_at` as the
marker both catalogues filter on and `extensions_published_content_check`
guaranteeing a published row is never half-written. `extension_revisions`
(renamed from `extension_submissions` in migration 0021) holds proposed
content, always attached to a real extension row and cascading with it.

Migration 0021 rebuilds `extensions` and replaces `extension_submissions` with
`extension_revisions`, because SQLite cannot relax `NOT NULL`, add a `CHECK`, or
add a foreign key in place. It also renames `extensions.author_id` to
`developer_id` — nothing public depended on the old name, since v1's response
field is `author` either way.

**Ordering in 0021 is load-bearing.** It never drops a table that still has
children, so `extension_submissions` is copied aside and dropped before
`extensions` is rebuilt. Foreign keys cannot be relaxed to avoid this:
`PRAGMA foreign_keys` is a no-op inside a transaction and wrangler wraps each
migration file in one, while `PRAGMA defer_foreign_keys` does not help either —
dropping a parent increments SQLite's deferred-violation counter per child row
and nothing decrements it, so the commit fails even when the data is sound. The
same constraint is why `developers` is not rebuilt: three tables reference it.
`migrations.test.ts` applies the chain under those conditions so this cannot
regress.

Apply migrations **only from this repository**, from `db/migrations`, with `npm run db:migrate:extensions-v2:local` / `:remote`. The Extensions site has no D1 migration source.

Migration `0020` is a check, not a schema change: it fails if an adopted developer row holds an id that a static route shadows (`developers.id` of `me`/`claims`/`unapproved`), which would make that row's detail page unreachable. If it fails, rename the row deliberately — the id is public and consumers pin it.

Migration `0021` refuses to run against data it cannot migrate, rather than aborting halfway through the rebuild. Each check selects the offending rows into a scratch table whose named `CHECK` can never hold, so the constraint name is the error message — SQLite has no `RAISE()` outside a trigger:

| Failure                                      | Meaning                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `extension_ids_must_not_differ_only_by_case` | Two catalogue ids collide under `idx_extensions_id_nocase`              |
| `submission_target_ids_must_not_be_reserved` | A submission targets an id a static route shadows                       |
| `extension_references_must_resolve`          | The `foreign_keys=OFF` rebuild would carry a dangling reference through |

None of these are repaired automatically: each is a decision about published data that belongs to a human. Reconcile and re-run — the migration has touched nothing at that point.

It does resolve one case itself: pending submissions whose ownership state can never satisfy approval are rejected, since one pending revision per extension would otherwise block the owner's next edit forever.

Migration `0021` also drops any submission filed under a developer that no longer exists: there is no `developer_id` such a row could carry that satisfies the new foreign key, and the profile it was filed under is already gone.

## Code Layout

See `AGENTS.md` for what belongs in `routes/`, `db/`, `schemas/`, `github/`, and `middleware.ts`. This service is the reference layout for larger services.
