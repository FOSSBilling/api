# Repository Guidelines

This is an npm workspace repository. Deployable components live under `services/`;
reusable libraries live under `libraries/`. Service-specific instructions live in
`services/api/AGENTS.md`.

- Install dependencies with `npm ci` from the repository root. Keep one root lockfile.
- Services must not import each other's source. Put code shared by actual callers in a private workspace package.
- Declare runtime dependencies in the workspace that uses them. Shared development tools are at the root.
- Preserve the API's existing feature structure inside `services/api/src/services/`.
- Keep provider entry points thin; domain and processing logic should remain portable.
- Local secrets and runtime state belong beside their service (`.dev.vars`, `.wrangler/`). Never commit credentials.
- Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build:api` before submitting changes.
- `npm run build:api` is a local dry run. `npm run cf-deploy` applies remote migrations and deploys production.
- Keep commits focused and use short imperative subjects. PRs should explain behaviour, validation and any deployment setup required.
