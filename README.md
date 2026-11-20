# FOSSBilling services

This repository contains separately deployed backend services and the libraries they share.
It uses npm workspaces and one root `package-lock.json`. Install dependencies from this
repository root with `npm ci`; each workspace declares its own dependencies.

| Workspace                                                                                | Purpose                                                                                | Deployment                            |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------- |
| [`services/api`](services/api/README.md)                                                 | HTTP API, authentication, persistence, job dispatch and publication                    | Cloudflare Workers                    |
| [`services/extension-package-processor`](services/extension-package-processor/README.md) | ZIP validation, manifest extraction and icon preparation                               | Netlify Function or another Node host |
| [`libraries/extension-packaging`](libraries/extension-packaging)                         | Shared manifest and processing contracts, ZIP implementation and storage/HTTP adapters | Bundled by its consumers              |
| [`libraries/logging`](libraries/logging)                                                 | Structured logging and credential redaction used by both services                      | Bundled by its consumers              |

Services do not import each other's source. Shared libraries are private npm
workspaces consumed directly from TypeScript source; there is no separate package
publication or library build step. Hosting configuration belongs to its service.

## Development

Use Node.js 24 or later. CI tests the workspaces on Node.js 26. Hosting runtime
selection belongs to each service's deployment configuration. Native dependencies
are installed for the build host.

```sh
npm ci
npm run dev                              # API and local S3 storage
npm run extension-package-processor:dev  # Package processor with local S3 storage
```

API migrations and other service-specific commands use npm's workspace option:

```sh
npm run db:migrate:all:local --workspace @fossbilling/api
npm run test:workers --workspace @fossbilling/api
npm test --workspace @fossbilling/extension-package-processor
```

Both development commands use local package and image storage by default, with
no B2 credentials required. The API's `.dev.vars` still supplies authentication
settings. See the service READMEs for details. Runtime
secrets and local state stay beside their service and are ignored by Git.

## Checks

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build:api                          # Wrangler dry run
npm run build:extension-package-processor  # Offline Netlify function build
```

Each workspace owns its tests and type checking. The root test and type-check
commands run all workspaces. Keep the single root lockfile updated with `npm install`
from the repository root; do not create service-specific lockfiles.

## Deployments

The services deploy independently from the same repository. Netlify configuration
and setup are documented in the [package processor README](services/extension-package-processor/README.md).
The same CI/CD workflow compiles the function without credentials and deploys
it through the Netlify CLI after validation. Main updates production and fixed
staging in one Netlify project; other branch pushes update preview aliases using
separate preview runtime credentials and storage.

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
migrations to succeed. Production and Previews keep package processing disabled
pending runtime verification and the controlled production package test.

`npm run cf-deploy` remains the explicit manual production command; it applies
remote migrations and deploys the API. It does not deploy the package processor.
