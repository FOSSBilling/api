# Repository Guidelines

## Project Structure & Module Organization

- `src/app/index.ts` is the worker entrypoint and route wiring for Hono.
- Feature logic lives in `src/services/` and should stay runtime-agnostic.
- Platform interfaces and adapters are in `src/lib/` with Cloudflare and Node implementations under `src/lib/adapters/`.
- Tests mirror the source layout under `test/`, with shared helpers in `test/utils/` and mocks in `test/mocks/`.
- Service configuration includes `wrangler.jsonc`, `worker-configuration.d.ts`, `tsconfig.json`, and the Drizzle/Vitest configs. ESLint and Prettier configuration live at the repository root.

### Service layout

Small services are flat: `index.ts` + `interfaces.ts` plus narrow helpers (for example `database.ts`, `db/`, `r2.ts`).

`extensions/v2` is the reference layout for anything larger, and new services should grow into it rather than inventing a third shape:

- `index.ts` — app assembly only: middleware, route registration, OpenAPI document. Route registration order is load-bearing where static paths must beat parameter paths; those cases carry comments.
- `middleware.ts` — service-specific Hono middleware.
- `routes/` — one module per route group, each exporting `register*Routes(app)`. `routes/errors.ts` maps domain error codes to HTTP status; `routes/app.ts` holds the typed app alias.
- `db/` — `schema.ts`, `migrations/`, one `*Database` class per workflow, plus `errors.ts` (D1 constraint classification) and `batch.ts`.
- `schemas/` — zod/OpenAPI contract split by domain. There is deliberately **no barrel**: import from `schemas/<domain>` directly so a module's dependencies are visible. This is why `extensions/v2` has no `interfaces.ts`.
- `github/` — outbound GitHub calls, kept out of the persistence modules.
- `email/` (extensions v2) — provider abstraction and templates. Service-root helpers (`revalidate.ts`, `resource-limits.ts`) stay at the service root. `previews/v1` follows the same split (`routes/`, `github/`, `schemas/`, plus `budget.ts` / `cache.ts`).

Use `getPlatform(c)` for cache access, service requests, rate-limit checks and background tasks. Keep binding conversion in platform adapters and inject background scheduling from the host entry point.

Route modules import `getExtensionsDb`/`getAuth`/`getPlatform` and middleware directly. There is no dependency-injection container; tests drive the real app through `app.request`.

Each service documents its own contract and operational detail in its own `README.md` (`src/services/<name>/<version>/README.md`). Keep API behaviour there rather than here or in the root README: this file is for conventions that apply when modifying the code.

## Build, Test, and Development Commands

- Run `npm ci` at the repository root to install workspace dependencies.
- `npm run dev`: start the local Cloudflare Workers dev server.
- `npm run cf-deploy`: apply remote D1 migrations, then deploy via Wrangler.
- `npm run cf-typegen`: regenerate `worker-configuration.d.ts`.
- `npm run build`: create a validated Worker artifact with deployment configuration and migrations.
- `npm run cf-preview`: deploy the prepared artifact as a Cloudflare Preview after staging migrations.
- `npm run db:migrate:all:local` / `db:migrate:all:remote`: apply all D1 migrations locally / remotely.
- `npm test`: run Workers and Node adapter tests for the API.
- `npm run test:workers`: run only the Workers pool.
- `npm run test:node`: run Node adapter tests via `vitest.node.config.ts`.
- `npm run test:coverage`: run tests with coverage.
- `npm run typecheck`: TypeScript typecheck without emit.
- Run `npm run lint` from the repository root.
- Run `npm run format` / `npm run format:check` from the repository root.

## Coding Style & Naming Conventions

- TypeScript (ES modules), 2-space indentation, and Prettier formatting (`trailingComma: "none"`).
- ESLint uses `@typescript-eslint` with Prettier compatibility; keep lint clean before opening PRs.
- Use kebab-case for service folders (for example `central-alerts`), and name tests `*.test.ts`.

## Testing Guidelines

- Vitest is the primary test runner; integration tests live in `test/integration/`.
- Prefer colocating tests in the matching `test/` path (for example `src/services/versions/v1` -> `test/services/versions/v1`).
- Run `npm test` at the repository root before release-related changes to cover all workspaces.

## Commit & Pull Request Guidelines

- Recent commits use short, imperative, sentence-case subjects (for example "Update API docs", "Refactor versions service").
- No ticket prefixes are evident; keep messages focused and under ~72 chars.
- PRs should include a concise summary, testing notes (commands run), and call out config/binding changes in `wrangler.jsonc`.

## Configuration & Secrets

- Local secrets go in `.dev.vars` (for example `GITHUB_APP_PRIVATE_KEY="..."`).
- Bindings, cron, and vars are defined in `wrangler.jsonc` (D1, KV, R2, Durable Objects, rate limiters, service bindings); keep names aligned with `CloudflareBindings`.
- Use Wrangler secrets for production tokens instead of committing them.
- `ASSERTION_SIGNING_SECRET`: HMAC key the extensions v2 API uses to verify short-lived bearer assertions minted by the extensions site (`src/lib/auth/bearer-assertion.ts`). Not sent over the wire — only signs/verifies server-side in each Worker. Add `ASSERTION_SIGNING_SECRET="..."` to `.dev.vars` for local dev; set via `wrangler secret put ASSERTION_SIGNING_SECRET` in production, matching the value configured in the extensions site's Worker.
- `EXTENSIONS_REVALIDATE_SECRET`: bearer token the extensions v2 API sends to the directory's `POST /api/revalidate` to purge cached pages after content mutations. Production uses the `EXTENSIONS_FRONTEND` service binding; Previews use HTTP to `EXTENSIONS_FRONTEND_URL`, configured in `wrangler.jsonc`. The secret must match the target directory deployment.

## Cache Revalidation

Any endpoint that mutates publicly visible content (revision approve/reject, moderator-correct, delist/relist, developer approve, developer profile upsert via `PUT /developers/me`, profile deletion via `DELETE /developers/me`, claim approve/reject, extension withdraw) must call `revalidateExtensions(c)` from `src/services/extensions/v2/revalidate.ts` after a successful write.

Skipping it does not break correctness — the site's `maxAge`/`stale-while-revalidate` windows bound staleness — but changes then take minutes instead of seconds to appear. Profile deletion keeps its purge even though the `developers` tag is currently a no-op.
