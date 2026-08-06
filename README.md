# FOSSBilling API Worker

This is the API service that acts as the central hub for FOSSBilling instances. It handles version checks, update information, and broadcasts system-wide alerts.

Everything is built on [Hono](https://hono.dev), making it lightweight and fast. While we currently deploy this to Cloudflare Workers, the code is designed to be platform-agnostic.

## What it does

The worker exposes three main services:

- **Versions Service** (`/versions/v1`)
  The source of truth for FOSSBilling updates. It fetches release data from GitHub, caches it for performance, and helps instances decide if they need to update.

- **Central Alerts** (`/central-alerts/v1`)
  Allows the project to push critical notifications to all FOSSBilling installations—useful for security hotfixes or major announcements.

- **Extensions** (`/extensions/v1`, `/extensions/v2`)
  Owns the complete Extensions domain and its `DB_EXTENSIONS` schema, including
  users, developers, submissions, claims, transfers, history, and catalogue data.
  The separate Extensions site keeps OIDC/session state but accesses this domain
  through the generated HTTPS API client; it must not bind or migrate `DB_EXTENSIONS`.

## Architecture

We've structured the app to separate the core logic from the specific runtime environment (Cloudflare, Node, etc.).

- **Application Logic**: Found in `src/services/versions/v1`, `src/services/central-alerts/v1`, etc. These feature modules don't know they are running on Cloudflare.
- **Platform Layer**: Located in `src/lib`. This defines interfaces for things like Cache, Database, and Environment variables.
- **Adapters**:
- `src/lib/adapters/cloudflare`: Real implementations using KV and D1.
- `src/lib/adapters/node`: Reference implementations (useful for testing or alternative deployments).

## APIs

### Versions (`/versions/v1`)

- `GET /versions/v1` - List all releases.
- `GET /versions/v1/:version` - Get details for a specific version (e.g. `1.0.0`); use `latest` to get the newest release.
- `GET /versions/v1/build_changelog/:current` - Generates a consolidated changelog for all releases greater than `:current` (in semantic version order).
- `GET /versions/v1/update` - Refreshes the releases cache. Requires bearer token authentication using `Authorization: Bearer <UPDATE_TOKEN>`.

All version responses include a `stale` field that indicates whether the data was served from cache after a failed fetch.

### Central Alerts (`/central-alerts/v1`)

- `GET /central-alerts/v1/list` - Public endpoint for fetching active alerts.

### Extensions v2 ownership verification

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

## Configuration

If you're running this yourself, you'll need a few things set up.

### Storage

We use [Cloudflare D1](https://developers.cloudflare.com/d1/) and [KV](https://developers.cloudflare.com/kv/).

- **D1 Database** (`DB_CENTRAL_ALERTS`): Stores the alert messages.
- **D1 Database** (`DB_EXTENSIONS`): Stores the complete Extensions domain. Apply
  its migrations only from this repository, from
  `src/services/extensions/v2/db/migrations`, with
  `db:migrate:extensions-v2:*`. The Extensions site has no D1 migration source.
  The `0000` users bootstrap mirrors the complete table created by the former
  site migration, so it is safe to re-run against the existing split-owned
  database without replacing rows; `0019` then adds the API-owned tombstone
  column. Back up the database and inspect `PRAGMA table_info(users)` before
  adoption, as with any schema ownership change.

- **KV Namespace** (`CACHE_KV`): Caches GitHub API responses so we don't hit rate limits.
- **KV Namespace** (`AUTH_KV`): Stores the `UPDATE_TOKEN` value for `/versions/v1/update`.

### Environment Variables

- `GITHUB_TOKEN`: A GitHub Personal Access Token (classic) with public repo read access.
- `ASSERTION_SIGNING_SECRET`: Shared HMAC secret used to verify the short-lived
  bearer assertions minted by the Extensions site. Configure the same value
  in both Workers; it is never sent to clients.
- `ASSERTION_SIGNING_SECRET_PREVIOUS`: Optional previous HMAC secret accepted
  during a signing-key rotation. Remove it after the new secret has been active
  for at least 65 seconds and all in-flight assertions have expired.

Extensions assertions use HS256 and include the exact issuer
`fossbilling-extensions`, audience `fossbilling-api/extensions-v2`, purpose
`user-authentication`, and protocol version `1`. Assertions are valid for at
most 60 seconds; the previous secret is accepted only as a temporary rotation
window.

To rotate the shared secret without interrupting requests, first set the API's
`ASSERTION_SIGNING_SECRET_PREVIOUS` to the current value, then replace the API's
active `ASSERTION_SIGNING_SECRET`, and finally replace the Extensions site's
active secret. After at least 65 seconds, verify requests and remove the API
previous secret.

## Development

Get the dependencies installed:

```bash
npm install
```

### Local Setup

1. Create a `.dev.vars` file for your secrets:

   ```env
   GITHUB_TOKEN="your-token"
   ASSERTION_SIGNING_SECRET="local-shared-secret"
   # Optional while rotating the shared assertion secret.
   # ASSERTION_SIGNING_SECRET_PREVIOUS="previous-local-shared-secret"
   ```

2. Apply migrations to the local D1 databases:

   ```bash
   npm run db:migrate:extensions-v2:local
   npm run db:migrate:central-alerts:local
   ```

3. (Optional) Store an update token in KV for `/versions/v1/update`:

   ```bash
   npx wrangler kv:key put --binding AUTH_KV UPDATE_TOKEN "dev-secret" --local
   ```

4. Spin up the dev server:

   ```bash
   npm run dev
   ```

You can now hit endpoints at `http://localhost:8787`.

### Testing

We use Vitest for testing. The suite includes unit tests for the endpoints and integration tests using the platform adapters.

```bash
npm run test
```

### Extensions v2 list pagination

`GET /extensions/v2/extensions` returns bounded pages of lightweight catalogue
items. List items intentionally omit `readme` and `releases`; retrieve the full
object from `GET /extensions/v2/extensions/{id}` for detail views. Follow
`pagination.next_cursor` by passing it unchanged as `cursor`, and treat cursors
as opaque. The default page size is 50 and `limit` may be set from 1 through 100.
