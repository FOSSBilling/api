# Extensions v2

**Base Path:** `/extensions/v2`

Self-service extension submission, developer-profile ownership, moderation, and
public catalogue browsing. v1 (`/extensions/v1`) remains available for existing
integrations.

This service owns the complete Extensions domain and its `DB_EXTENSIONS` schema:
users, developers, submissions, claims, transfers, history, and catalogue data.
The separate Extensions site keeps OIDC/session state but reaches this domain
through the generated HTTPS API client; it must not bind or migrate
`DB_EXTENSIONS`.

## Endpoints

Endpoints are not listed here. The service publishes its own contract, and a
hand-maintained copy would drift from it:

- **OpenAPI document:** `GET /extensions/v2/openapi.json`
- **Reference UI:** `GET /extensions/v2/docs`

What follows is the behaviour that document cannot express.

## Authentication

Requests carry a short-lived bearer assertion minted by the Extensions site and
verified here with a shared HMAC secret (`ASSERTION_SIGNING_SECRET`; see the
root README for where to configure it).

Assertions use HS256 and include the exact issuer `fossbilling-extensions`,
audience `fossbilling-api/extensions-v2`, purpose `user-authentication`, and
protocol version `1`. They are valid for at most 60 seconds.

### Rotating the shared secret

`ASSERTION_SIGNING_SECRET_PREVIOUS` is an optional second secret accepted only
as a temporary rotation window. To rotate without interrupting requests:

1. Set the API's `ASSERTION_SIGNING_SECRET_PREVIOUS` to the current value.
2. Replace the API's active `ASSERTION_SIGNING_SECRET`.
3. Replace the Extensions site's active secret.
4. After at least 65 seconds, verify requests and remove the API's previous
   secret.

Remove the previous secret once the new one has been active for at least 65
seconds and all in-flight assertions have expired.

## Ownership verification

For organization developer IDs, GitHub membership is used for automatic
verification only when the API has a valid, unexpired membership snapshot. A
fresh snapshot that does not contain the organization remains a confirmed
mismatch and is rejected. Missing, malformed, or expired evidence is
inconclusive instead: a new profile remains unapproved and a claim remains
pending for manual moderator review. Moderators must verify ownership through
their normal out-of-band process before approving either workflow.

`github_org_verified` being absent or `null` is a review signal, not proof of
ownership or an authorization grant. Consumers and moderation tooling must not
treat an inconclusive result as verified.

## List pagination

`GET /extensions/v2/extensions` returns bounded pages of lightweight catalogue
items. List items intentionally omit `readme` and `releases`; retrieve the full
object from `GET /extensions/v2/extensions/{id}` for detail views. Follow
`pagination.next_cursor` by passing it unchanged as `cursor`, and treat cursors
as opaque. The default page size is 50 and `limit` may be set from 1 through 100.

Cursors carry a version field and are validated on decode, so a cursor from an
older format is rejected with `INVALID_CURSOR` (HTTP 422) rather than being
misread. Clients should treat that as "restart pagination from the first page",
not as an error to surface.

## Database

Uses the D1 binding `DB_EXTENSIONS`, shared with v1 (read-only there). This
service owns the schema and the migrations.

Apply migrations **only from this repository**, from `db/migrations`, with
`npm run db:migrate:extensions-v2:local` / `:remote`. The Extensions site has no
D1 migration source.

Adopting the database from the former split-ownership arrangement: the `0000`
users bootstrap mirrors the complete table created by the old site migration, so
it is safe to re-run against an existing database without replacing rows; `0019`
then adds the API-owned tombstone column. Back up the database and inspect
`PRAGMA table_info(users)` before adoption, as with any schema ownership change.

## Code layout

See `AGENTS.md` for what belongs in `routes/`, `db/`, `schemas/`, `github/`, and
`middleware.ts`. This service is the reference layout for larger services.
