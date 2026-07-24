# Repository Guidelines

## Project Structure & Module Organization

- `src/app/index.ts` is the worker entrypoint and route wiring for Hono.
- Feature logic lives in `src/services/` (for example `central-alerts/v1`, `versions/v1`, `stats/v1`) and should stay runtime-agnostic.
- Platform interfaces and adapters are in `src/lib/` with Cloudflare and Node implementations under `src/lib/adapters/`.
- Tests mirror the source layout under `test/`, with shared helpers in `test/utils/` and mocks in `test/mocks/`.
- Runtime/config files include `wrangler.jsonc`, `worker-configuration.d.ts`, `tsconfig.json`, `eslint.config.ts`, and `prettier.config.ts`.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run dev`: start the local Cloudflare Workers dev server.
- `npm run deploy`: deploy the worker via Wrangler.
- `npm run test`: run the default Vitest suite (Workers pool).
- `npm run test:node`: run Node adapter tests via `vitest.node.config.ts`.
- `npm run test:coverage`: run tests with coverage.
- `npm run typecheck`: TypeScript typecheck without emit.
- `npm run lint` / `npm run lint:fix`: lint the codebase (with optional fixes).
- `npm run format` / `npm run format:check`: format or verify formatting with Prettier.

## Coding Style & Naming Conventions

- TypeScript (ES modules), 2-space indentation, and Prettier formatting (`trailingComma: "none"`).
- ESLint uses `@typescript-eslint` with Prettier compatibility; keep lint clean before opening PRs.
- Use kebab-case for service folders (for example `central-alerts`), and name tests `*.test.ts`.

## Testing Guidelines

- Vitest is the primary test runner; integration tests live in `test/integration/`.
- Prefer colocating tests in the matching `test/` path (for example `src/services/versions/v1` -> `test/services/versions/v1`).
- Run `npm run test:all` before release-related changes to cover both worker and node adapters.

## Commit & Pull Request Guidelines

- Recent commits use short, imperative, sentence-case subjects (for example "Update API docs", "Refactor versions service").
- No ticket prefixes are evident; keep messages focused and under ~72 chars.
- PRs should include a concise summary, testing notes (commands run), and call out config/binding changes in `wrangler.jsonc`.

## Configuration & Secrets

- Local secrets go in `.dev.vars` (for example `GITHUB_TOKEN="..."`).
- Bindings for D1/KV are defined in `wrangler.jsonc`; keep names aligned with `CloudflareBindings`.
- Use Wrangler secrets for production tokens instead of committing them.
- `ASSERTION_SIGNING_SECRET`: HMAC key the extensions v2 API uses to verify short-lived
  bearer assertions minted by the extensions site (`src/lib/auth/bearer-assertion.ts`).
  Not sent over the wire — only signs/verifies server-side in each Worker. Add
  `ASSERTION_SIGNING_SECRET="..."` to `.dev.vars` for local dev; set via
  `wrangler secret put ASSERTION_SIGNING_SECRET` in production, matching the value
  configured in the extensions site's Worker.

## Stats API v1

- Provides release statistics visualization for FOSSBilling versions.
- HTML endpoint: `GET /stats/v1/` - Returns a client-side rendered page with Chart.js visualizations.
- Data endpoint: `GET /stats/v1/data` - Returns aggregated statistics data for the charts.
- Charts include: Release Size Graph (line), PHP Version Requirements (line), Patches Per Release (bar), and Releases Per Year (bar).
- Stats data is cached with a TTL of 24 hours and reuses release data from the versions service.
- Service follows the same caching patterns as versions API, including graceful handling of GitHub API errors.
