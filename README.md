# FOSSBilling services

This repository contains separately deployed backend services and the libraries they share.
It uses npm workspaces and one root `package-lock.json`. Install dependencies from this
repository root with `npm ci`; each workspace declares its own dependencies.

| Workspace                                                              | Purpose                                                                                | Deployment                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------- |
| [`services/api`](services/api/README.md)                               | HTTP API, authentication, persistence, queues and publication                          | Cloudflare Workers                    |
| [`services/extension-packager`](services/extension-packager/README.md) | ZIP validation, manifest replacement and icon preparation                              | Netlify Function or another Node host |
| [`libraries/extension-packaging`](libraries/extension-packaging)       | Shared manifest and processing contracts, ZIP implementation and storage/HTTP adapters | Bundled by its consumers              |
| [`libraries/logging`](libraries/logging)                               | Structured logging and credential redaction used by both services                      | Bundled by its consumers              |

Services do not import each other's source. Shared libraries are private npm
workspaces consumed directly from TypeScript source; there is no separate package
publication or library build step. Hosting configuration belongs to its service.

## Development

Use Node.js 24 or later. CI and the Netlify packager use Node.js 26. Native
dependencies are installed for the build host.

```sh
npm ci
npm run dev                    # API, using services/api/.dev.vars
npm run extension-packager:dev  # Node packager, using services/extension-packager/.dev.vars
```

API migrations and other service-specific commands use npm's workspace option:

```sh
npm run db:migrate:all:local --workspace @fossbilling/api
npm run test:workers --workspace @fossbilling/api
npm test --workspace @fossbilling/extension-packager
```

See the service READMEs for local storage and authentication configuration. Runtime
secrets and local state stay beside their service and are ignored by Git.

## Checks

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build:api  # Wrangler dry run; does not deploy or apply remote migrations
```

Each workspace owns its tests and type checking. The root test and type-check
commands run all workspaces. Keep the single root lockfile updated with `npm install`
from the repository root; do not create service-specific lockfiles.

## Deployments

The services deploy independently from the same repository. Netlify configuration
and setup are documented in the [packager README](services/extension-packager/README.md).

The API uses the same pinned [shared Cloudflare workflow](https://github.com/FOSSBilling/.workflows)
as `fossbilling.org`. [CI/CD](.github/workflows/ci.yml) validates the workspaces and
builds a self-contained Worker artifact, including deployment configuration and SQL.

- Pushes to `main` migrate production D1 and deploy the tested artifact.
- Other branch pushes migrate staging D1 and deploy Previews once `API_PREVIEW_RESOURCES`
  is configured; until then, validation and artifact checks run with an explicit Preview skip summary.
  Previews have stable branch and
  immutable commit URLs recorded on matching PRs.
- PR runs validate without deploying. The [Cloudflare Events workflow](.github/workflows/cloudflare-events.yml)
  updates PR comments when a PR opens later or a run finishes, including failed attempts.

See the [API deployment setup](services/api/README.md#deployment) for GitHub environments,
staging resource IDs, Preview secrets, migration behaviour and the Workers Builds cutover.
All production and Preview deployments require validation, the build and migrations
to succeed. Previews keep package processing disabled because Cloudflare Previews
cannot consume Queues. Production packaging also remains disabled pending Netlify
runtime verification and the controlled production package test.

`npm run cf-deploy` remains the explicit manual production command; it applies
remote migrations and deploys the API. It does not deploy the packager.
