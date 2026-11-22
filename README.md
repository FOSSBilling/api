# FOSSBilling services

This repository contains the FOSSBilling API and its supporting libraries.
It uses npm workspaces and one root `package-lock.json`. Install dependencies from this
repository root with `npm ci`; each workspace declares its own dependencies.

| Workspace                                                        | Purpose                                                      | Deployment               |
| ---------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------ |
| [`services/api`](services/api/README.md)                         | HTTP API, authentication, package processing and publication | Cloudflare Workers       |
| [`libraries/extension-packaging`](libraries/extension-packaging) | Shared ZIP processing, manifest and storage adapters         | Bundled by its consumers |
| [`libraries/logging`](libraries/logging)                         | Structured logging and credential redaction                  | Bundled by its consumers |

Services do not import each other's source. Shared libraries are private npm
workspaces consumed directly from TypeScript source; there is no separate package
publication or library build step. Hosting configuration belongs to its service.

## Development

Use Node.js 24 or later. CI tests the workspaces on Node.js 26. Hosting runtime
selection belongs to each service's deployment configuration. Native dependencies
are installed for the build host.

```sh
npm ci
npm run dev  # API and local S3 storage
```

API migrations and other service-specific commands use npm's workspace option:

```sh
npm run db:migrate:all:local --workspace @fossbilling/api
npm run test:workers --workspace @fossbilling/api
```

The API uses local package and image storage in development. Its `.dev.vars`
supplies authentication settings. See the
[API README](services/api/README.md) for configuration.

## Checks

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build:api  # Wrangler dry run
```

Each workspace owns its tests and type checking. The root test and type-check
commands run all workspaces. Keep the single root lockfile updated with `npm install`
from the repository root; do not create service-specific lockfiles.

## Deployments

The API uses the same pinned [shared Cloudflare workflow](https://github.com/FOSSBilling/.workflows)
as `fossbilling.org`. [CI/CD](.github/workflows/ci.yml) validates the workspaces and
builds a self-contained Worker artifact, including deployment configuration and SQL.

- Pushes to `main` migrate production D1 and deploy the tested artifact.
- Other branch pushes migrate staging D1 and deploy Previews using the bindings in
  `services/api/wrangler.jsonc` under `previews`.
  Previews have stable branch and immutable commit URLs recorded on matching PRs.
- PR runs validate without deploying. The [Cloudflare Events workflow](.github/workflows/cloudflare-events.yml)
  updates PR comments when a PR opens later or a run finishes, including failed attempts.

See the [API deployment setup](services/api/README.md#deployment) for GitHub environments,
staging resource IDs, Preview secrets, migration behaviour and the Workers Builds cutover.
All API production and Preview deployments require validation, the API build and
migrations to succeed. Package processing is enabled in production and disabled
by default in Previews. See the [packaging setup](services/api/src/services/extensions/v2/PACKAGING.md)
for storage configuration and testing.

`npm run cf-deploy` remains the explicit manual production command; it applies
remote migrations and deploys the API.
