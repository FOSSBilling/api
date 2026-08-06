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
  Owns the complete Extensions domain and its `DB_EXTENSIONS` schema. The separate
  Extensions site keeps OIDC/session state but accesses this domain through the
  generated HTTPS API client; it must not bind or migrate `DB_EXTENSIONS`.
  See [`src/services/extensions/v2/README.md`](src/services/extensions/v2/README.md).

## Architecture

We've structured the app to separate the core logic from the specific runtime environment (Cloudflare, Node, etc.).

- **Application Logic**: Found in `src/services/versions/v1`, `src/services/central-alerts/v1`, etc. These feature modules don't know they are running on Cloudflare.
  Smaller services are a flat `index.ts` + `interfaces.ts`; `src/services/extensions/v2` is the
  reference layout for larger ones, splitting into `routes/`, `db/`, `schemas/`, and `github/`.
  See `AGENTS.md` for what belongs in each.
- **Platform Layer**: Located in `src/lib`. This defines interfaces for things like Cache, Database, and Environment variables.
- **Adapters**:
- `src/lib/adapters/cloudflare`: Real implementations using KV and D1.
- `src/lib/adapters/node`: Reference implementations (useful for testing or alternative deployments).

## APIs

Each service documents its own endpoints and behaviour:

| Service        | Base path                          | Docs                                                                                   |
| -------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| Versions       | `/versions/v1`                     | [`src/services/versions/v1/README.md`](src/services/versions/v1/README.md)             |
| Central Alerts | `/central-alerts/v1`               | [`src/services/central-alerts/v1/README.md`](src/services/central-alerts/v1/README.md) |
| Stats          | `/stats/v1`                        | [`src/services/stats/v1/README.md`](src/services/stats/v1/README.md)                   |
| Extensions     | `/extensions/v1`, `/extensions/v2` | [`src/services/extensions/v2/README.md`](src/services/extensions/v2/README.md)         |

Extensions v2 also publishes a live OpenAPI document at
`/extensions/v2/openapi.json` and a reference UI at `/extensions/v2/docs`.

## Configuration

If you're running this yourself, you'll need a few things set up.

### Storage

We use [Cloudflare D1](https://developers.cloudflare.com/d1/) and [KV](https://developers.cloudflare.com/kv/).

- **D1 Database** (`DB_CENTRAL_ALERTS`): Stores the alert messages.
- **D1 Database** (`DB_EXTENSIONS`): Stores the complete Extensions domain.
  Migrations are owned by extensions v2 and applied only from this repository —
  see [its README](src/services/extensions/v2/README.md#database) for the
  migration and adoption procedure.
- **KV Namespace** (`CACHE_KV`): Caches GitHub API responses so we don't hit rate limits.
- **KV Namespace** (`AUTH_KV`): Stores the `UPDATE_TOKEN` value for `/versions/v1/update`.

### Environment Variables

- `GITHUB_TOKEN`: A GitHub Personal Access Token (classic) with public repo read access.
- `ASSERTION_SIGNING_SECRET`: Shared HMAC secret used to verify the short-lived
  bearer assertions minted by the Extensions site. Configure the same value
  in both Workers; it is never sent to clients.
- `ASSERTION_SIGNING_SECRET_PREVIOUS`: Optional previous HMAC secret accepted
  during a signing-key rotation.

Only extensions v2 consumes these. For the assertion format and the
rotation procedure, see
[its README](src/services/extensions/v2/README.md#authentication).

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
