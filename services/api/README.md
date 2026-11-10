# FOSSBilling API Worker

This service is an npm workspace. Run `npm ci` from the [repository root](../../README.md).
The commands below run from `services/api` unless stated otherwise.

This is the API service that acts as the central hub for FOSSBilling instances. It serves version checks, system-wide alerts, the extensions directory, preview builds, and release stats.

The HTTP layer uses [Hono](https://hono.dev) and deploys to Cloudflare Workers. Shared packaging code and several platform capabilities use provider-neutral interfaces; database and specialised storage integrations still use Cloudflare bindings.

## What it does

The worker exposes five services:

- **Versions** (`/versions/v1`)
  The source of truth for FOSSBilling updates. It fetches release data from GitHub, caches it for performance, and helps instances decide if they need to update.

- **Central Alerts** (`/central-alerts/v1`)
  Allows the project to push critical notifications to all FOSSBilling installations—useful for security hotfixes or major announcements.

- **Extensions** (`/extensions/v1`, `/extensions/v2`)
  Owns the complete Extensions domain and its `DB_EXTENSIONS` schema. `v2` is authoritative. `v1` is deprecated; its badge URLs retire on **5 February 2027** ([migration and retirement policy](src/services/extensions/v1/README.md)). The separate Extensions site keeps OIDC/session state but accesses this domain through the
  generated HTTPS API client; it must not bind or migrate `DB_EXTENSIONS`.
  See [`src/services/extensions/v2/README.md`](src/services/extensions/v2/README.md).

- **Previews** (`/previews/v1`)
  Resolves FOSSBilling preview builds — the current main preview and per-PR/per-commit builds produced by FOSSBilling/FOSSBilling's GitHub Actions workflows. Read-only; GitHub Actions and R2 are the sources of truth, not this service.
  See [`src/services/previews/v1/README.md`](src/services/previews/v1/README.md).

- **Stats** (`/stats/v1`)
  Aggregates release data through the versions service's shared releases cache into charts and JSON; a cold cache can trigger a GitHub fetch through that shared path.
  See [`src/services/stats/v1/README.md`](src/services/stats/v1/README.md).

## Architecture

Feature modules live under `src/services/`. Smaller services are flat; larger ones,
such as `extensions/v2`, split into `routes/`, `db/`, `schemas/` and `github/`.

`src/lib/context.ts` exposes caches, queues, environment values, service requests,
rate-limit checks and background-task scheduling. Cloudflare adapters translate
bindings into these capabilities. The Worker entry point supplies the request's
`waitUntil` callback; another host can supply its own task scheduling. Application
helpers use ordinary `Request`/`Response` values rather than Cloudflare `Fetcher`s.

Database code uses Drizzle's D1 driver and some features access R2 or Durable Objects
directly. Moving the API to another host would still require replacing those
integrations. The Node adapters currently provide caches and environment access,
not a complete alternative API runtime.

Package processing uses the shared library's storage, processor and image interfaces.
B2 storage configuration lives in `extensions/v2/packages/store.ts`; Cloudflare Queue
delivery and acknowledgement stay in `src/lib/adapters/cloudflare/packaging-jobs.ts`.
The separately hosted packager does not import API source or Cloudflare bindings.

## APIs

Each service documents its own endpoints and behaviour:

| Service        | Base path                          | Docs                                                                                   |
| -------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| Versions       | `/versions/v1`                     | [`src/services/versions/v1/README.md`](src/services/versions/v1/README.md)             |
| Central Alerts | `/central-alerts/v1`               | [`src/services/central-alerts/v1/README.md`](src/services/central-alerts/v1/README.md) |
| Stats          | `/stats/v1`                        | [`src/services/stats/v1/README.md`](src/services/stats/v1/README.md)                   |
| Extensions     | `/extensions/v1`, `/extensions/v2` | [`src/services/extensions/v2/README.md`](src/services/extensions/v2/README.md)         |
| Previews       | `/previews/v1`                     | [`src/services/previews/v1/README.md`](src/services/previews/v1/README.md)             |

Extensions v2 and Previews v1 also publish a live OpenAPI document (`/extensions/v2/docs/openapi.json`, `/previews/v1/docs/openapi.json`) and a reference UI (`/extensions/v2/docs`, `/previews/v1/docs`).

## Configuration

If you're running this yourself, you'll need a few things set up.

### Storage

We use [Cloudflare D1](https://developers.cloudflare.com/d1/) and [KV](https://developers.cloudflare.com/kv/).

- **D1 Database** (`DB_CENTRAL_ALERTS`): Stores the alert messages.
- **D1 Database** (`DB_EXTENSIONS`): Stores the complete Extensions domain.
  Migrations are owned by extensions v2 and applied only from this repository — see [its README](src/services/extensions/v2/README.md#database) for the migration and adoption procedure.
- **KV Namespace** (`CACHE_KV`): Caches GitHub API responses so we don't hit rate limits.
- **KV Namespace** (`AUTH_KV`): Stores the `UPDATE_TOKEN` value for `/versions/v1/update`.
- **R2 Bucket** (`DOWNLOAD_BUCKET`): Shared by versions, previews, and stats for release/preview zips — see [`src/services/previews/v1/README.md`](src/services/previews/v1/README.md) and the comment in `wrangler.jsonc` for which bucket this points at and why.
- **Durable Object** (`PREVIEW_GITHUB_BUDGET`): Token bucket limiting previews GitHub calls. Policy lives in `src/services/previews/v1/budget.ts`.
- **Rate limiters** (`EXTENSION_WRITE_RATE_LIMITER`, `PROFILE_CREATION_RATE_LIMITER`): Edge pacing for extension writes and profile creation. Durable quotas are enforced in D1; see [extensions v2 README](src/services/extensions/v2/README.md#limits-and-budgets).
- **Service binding** (`EXTENSIONS_FRONTEND`): Private binding to the Extensions site worker, used to purge cached extension pages after mutations.
- **Cron** (`0 * * * *`): Hourly extension resource maintenance. See [extensions v2 README](src/services/extensions/v2/README.md#revisions-and-retention).

### Environment Variables

Production B2 connection details and MXroute server/username are managed in the
Worker dashboard under **Settings > Variables and Secrets** as runtime variables.
Credentials are stored as secrets. Build environment variables do not configure
the running Worker. `keep_vars: true` preserves dashboard-managed variables on
Wrangler deployments; keep their values out of the committed `vars` map and docs.
Public URLs and deployment controls remain in `wrangler.jsonc`.

For local development, put operational values and credentials in the ignored
`.dev.vars` file. Document variable names and placeholders, not production values.
Package storage configuration is listed in [PACKAGING.md](src/services/extensions/v2/PACKAGING.md).

- `GITHUB_TOKEN`: A GitHub Personal Access Token (classic) with public repo read access.
- `ASSERTION_SIGNING_SECRET`: Shared HMAC secret used to verify the short-lived bearer assertions minted by the Extensions site. Configure the same value in both Workers; it is never sent to clients.
- `ASSERTION_SIGNING_SECRET_PREVIOUS`: Optional previous HMAC secret accepted during a signing-key rotation.
- `EXTENSIONS_REVALIDATE_SECRET`: Bearer token the API sends to the Extensions site's `POST /api/revalidate` (over the `EXTENSIONS_FRONTEND` service binding) to purge the site's CDN-cached extension pages after content mutations. Configure the same value in both Workers; it is never sent to clients.
- `EXTENSIONS_V2_EMAIL_PROVIDER`: `mxroute` or `resend` to send moderator notification emails, or unset/`disabled` to skip sending.
- `EXTENSIONS_V2_EMAIL_FROM`: Sender address for notification emails (default `noreply@fossbilling.org`).
- `EXTENSIONS_V2_EMAIL_REPLY_TO`: Optional Reply-To address for a monitored inbox. Omit when unset (no Reply-To header is sent) — notification emails do not invite replies.
- `EXTENSIONS_V2_MXROUTE_SERVER`, `EXTENSIONS_V2_MXROUTE_USERNAME`: Dashboard-managed runtime variables identifying the mailbox for the MXroute SMTP API (`https://smtpapi.mxroute.com/`). Required when `EXTENSIONS_V2_EMAIL_PROVIDER=mxroute`.
- `EXTENSIONS_V2_MXROUTE_PASSWORD`: Mailbox password, stored as a secret. Required when `EXTENSIONS_V2_EMAIL_PROVIDER=mxroute`.
- `EXTENSIONS_V2_RESEND_API_KEY`: API key for Resend. Required when `EXTENSIONS_V2_EMAIL_PROVIDER=resend`.
- `EXTENSIONS_RETENTION_MODE`: `dry-run` (report only) or `compact` (prune old revision bodies). See [extensions v2 README](src/services/extensions/v2/README.md#revisions-and-retention).
- `M2M_ISSUER`, `M2M_JWKS_URL`, `M2M_AUDIENCE`: Issuer, JWKS endpoint, and expected audience for machine-to-machine access tokens minted by the central auth service (`FOSSBilling/auth`). Defaults live in `wrangler.jsonc`; preview environments need them pointed at the issuing preview. See [extensions v2 README](src/services/extensions/v2/README.md#machine-publishing).

The extension-specific settings apply to extensions v2; Versions, Previews and
Stats also use `GITHUB_TOKEN`. For the assertion format and the rotation procedure, see [its README](src/services/extensions/v2/README.md#authentication).

## Development

### Local Setup

1. Create a `.dev.vars` file for local runtime variables and secrets:

   ```env
   GITHUB_TOKEN="your-token"
   ASSERTION_SIGNING_SECRET="local-shared-secret"
   EXTENSIONS_REVALIDATE_SECRET="local-revalidate-secret"
   # Optional while rotating the shared assertion secret.
   # ASSERTION_SIGNING_SECRET_PREVIOUS="previous-local-shared-secret"
   ```

2. Apply migrations to the local D1 databases:

   ```bash
   npm run db:migrate:all:local
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

We use Vitest. Unit tests run under the Workers pool; Node adapter tests use a separate config.

```bash
npm run test:workers  # workers pool
npm test              # workers + node adapters
```

```bash
npm run typecheck
npm run lint --prefix ../..
```

### Deployment

[CI/CD](../../.github/workflows/ci.yml) uses the pinned shared Cloudflare workflow
from [FOSSBilling/.workflows](https://github.com/FOSSBilling/.workflows), matching
`fossbilling.org`'s Preview URLs, deployment summaries and PR comment history.

Validation and artifact builds run on branch pushes and PRs. A push can deploy only
after workspace validation, the build and D1 migrations succeed. `main` targets
production; other branches target Previews once `API_PREVIEW_RESOURCES` is configured.
Until then, branch builds report that Preview migrations and deployment are skipped;
validation and artifact checks still run. PR runs, including forks, never receive
deployment credentials or apply remote migrations.

The artifact contains the compiled Worker, `wrangler.json`, and SQL migrations.
Deployment does not rebuild the Worker. Production migrations use that artifact's
production bindings. Preview migrations use its generated
`wrangler.preview-migrations.json`, derived from the same bindings used by the Preview.
Migration jobs serialize access to the shared staging databases.

#### Setup before switching deployment

1. Configure GitHub `production` and `preview` environments. Set the
   `CLOUDFLARE_API_TOKEN` repository secret, or override it with a separate token
   in each environment. Set `CLOUDFLARE_ACCOUNT_ID` as a repository variable
   shared by both deployment targets. Restrict the production environment to `main`.
   Deployment tokens need Editor access to the API Worker, Workers Routes Write
   for its zone, D1 Read/Write for migrations, and Queues Read/Write to configure
   the existing production consumer. Preview deployments need access to the API
   Worker and staging D1 migrations, without Queue or production route changes.
   Preview data resources and runtime secrets must be separate from production.
2. Provision staging D1 databases, KV namespaces, a download bucket and a separately
   deployed staging Extensions frontend. Set the repository variable `API_PREVIEW_RESOURCES`
   to their identifiers, using the following JSON shape:

   ```json
   {
     "DB_EXTENSIONS": "<staging-extensions-database-uuid>",
     "DB_CENTRAL_ALERTS": "<staging-alerts-database-uuid>",
     "AUTH_KV": "<staging-auth-namespace-id>",
     "CACHE_KV": "<staging-cache-namespace-id>",
     "DOWNLOAD_BUCKET": "<staging-download-bucket-name>",
     "EXTENSIONS_FRONTEND": "<staging-extensions-worker-name>"
   }
   ```

   The build refuses production resource IDs and duplicated IDs. These are operational
   identifiers, not credentials. The variable is optional for local production bundle
   checks. When absent, CI skips Preview migrations and deployment; a malformed or
   production resource configuration still fails the build. Previews share these
   staging resources; they do not automatically receive separate D1/KV/R2 data.

3. Configure Preview runtime secrets in the API Worker's **Previews Base** settings.
   Use separate assertion-signing and revalidation secrets, matching both with
   the staging frontend. Use a read-only GitHub token if authenticated GitHub
   requests are needed. Set M2M issuer,
   JWKS and audience variables there when using a separate test issuer. Operational
   production variables and secrets remain dashboard-managed with `keep_vars: true`.
4. Configure required checks for the new validation/build job names, then disable the
   API's Cloudflare Workers Builds Git integration to avoid duplicate deployments.

The workflow compiles the branch's Preview settings into the artifact. Each Preview
receives isolated Durable Object state; the data bindings above are shared staging
resources. A frontend service binding calls that Worker's normal deployment, so use a
staging Worker name rather than the production Extensions worker. Configure that
frontend with HTTP API transport and a Preview API URL, without production routes
or API bindings. A long-lived Preview such as `staging` can back this frontend;
refresh it from the prepared artifact with `npm run cf-preview -- --name staging`.
Register its OAuth callback with a dedicated test client before testing sign-in.

Cloudflare Previews cannot consume Queues or receive Cron Triggers. Their configuration
therefore disables packaging and notification email, and omits Queue bindings. Full
packaging/consumer testing needs a separately deployed staging Worker and Queue, or the
controlled production test. See [Cloudflare's Preview resource behaviour](https://developers.cloudflare.com/workers/previews/resources/).

The [Cloudflare Events workflow](../../.github/workflows/cloudflare-events.yml) runs the
trusted shared comment handler on workflow completion and PR events. It reads deployment
metadata without checking out or executing PR code. Renovate tracks the pinned shared
workflow references in both files.

#### Local deployment commands

From the repository root, `npm run build:api` validates the bundle and prepares the
artifact without remote writes. To prepare a Preview artifact, supply
`API_PREVIEW_RESOURCES` in the environment when building. Apply its staging migrations
before running `npm run cf-preview`; CI performs those steps automatically.

`npm run cf-deploy` remains a deliberate manual production command. It applies remote
migrations and deploys through Wrangler. Neither command deploys the separate
[extension packager](../extension-packager/README.md). Production packaging remains disabled.
