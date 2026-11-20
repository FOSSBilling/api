# Extension package processor

This Node service validates uploaded ZIPs, reads their manifests, stores the ZIPs
unchanged, and prepares display icons. It uses the shared
`@fossbilling/extension-packaging` library. The Netlify function in
`netlify/functions/extension-package-processor.ts` calls the same Request/Response
handler used locally in `src/handler.ts`.

## Local development

Install dependencies with `npm ci` from the repository root. Start the API and
package processor in separate terminals:

```sh
npm run dev
npm run extension-package-processor:dev
```

The API command also starts Wrangler's local R2 S3 service. Both commands apply
`libraries/extension-packaging/development.env` after service-specific `.dev.vars`
files. This deliberately overrides old B2 and package processor settings so normal
development stays local. Other service settings still come from `.dev.vars`.
The API needs its own `.dev.vars` for authentication; the package processor needs no B2
credentials or local secret file.

The package processor listens on `127.0.0.1:8790`. It reads and writes ZIPs in
`extension-packages-local` through the API's local S3 endpoint on port 8787.
The API stores prepared icons in `extension-assets-local` and serves them locally.
Objects persist in the API's `.wrangler/state` across restarts. These buckets exist
only on your machine; no R2 or B2 bucket is created remotely.

Local S3 uses Wrangler's experimental endpoint, supported by the pinned Wrangler
version. Production continues to use private B2 storage. Ordinary tests mock S3;
the API's local-storage test also exercises the real local R2 endpoint.

## Netlify deployment

Use one Netlify project, `fb-api-packager`, for production and previews. GitHub
Actions builds and deploys the function through the pinned Netlify CLI in the root
lockfile. Only the package processor and its imported libraries are deployed to Netlify;
the API continues to deploy separately to Cloudflare.

The [CI/CD workflow](../../.github/workflows/ci.yml) builds the function without
credentials on every push and PR, using `npm run build:extension-package-processor`. A smoke
check loads the handler from the extracted ZIP to catch missing entry points or
dependencies.

Deployment jobs download the compiled function after validation succeeds, then
Netlify packages it with the pinned native dependencies before upload. They do not
recompile source or depend on Netlify's short-lived build cache:

| Source              | Deployment                        | Netlify variables      |
| ------------------- | --------------------------------- | ---------------------- |
| `main`              | Production project URL            | Production context     |
| `main`              | Fixed `staging` alias             | Branch deploys context |
| Other branch pushes | `branch-<branch-name-hash>` alias | Branch deploys context |

PR runs validate and build without deploying or receiving deployment credentials.
Deployment links appear in the job summary and one updated package processor comment per
same-repository PR, alongside the existing API Preview comment. It identifies the
reported commit and CI attempt. Only metadata from the current attempt is used;
canceled reruns without metadata do not fall back to an earlier deployment.
Failed attempts do not link to an older deployment as if it were current.
Unchanged comments are not rewritten.
As with Cloudflare Previews, each attempt records a small metadata artifact. The
reporting workflow also runs when a PR opens or CI finishes, so it covers PRs
opened after deployment and failed builds. `pull_request_target` and `workflow_run`
use default-branch reporting code. Direct `workflow_call` jobs on same-repository
pushes use the pushed code with PR-write permission under the trusted-maintainer
model. No reporting job receives Netlify credentials.
Production uploads use `--prod`; aliases use the **Branch deploys** runtime
variables. The CLI's `--context` flag only applies when building, so it is not
passed with `--no-build`. `staging` is reserved for the fixed deployment. Avoid
Git branch deployments with matching aliases and branch-specific variable overrides.

### Project and Actions setup

Configure the existing project with the repository root as its base directory and
`services/extension-package-processor` as its package directory. Its configuration file is
`services/extension-package-processor/netlify.toml`; publish and function paths are relative
to the repository root. The build command compiles the service and shared
TypeScript libraries with esbuild before Netlify packages the function. This
avoids Netlify's tracer rewriting workspace imports over the entry point.

Set these GitHub Actions settings on the API repository:

- Secret `NETLIFY_AUTH_TOKEN`: a Netlify deployment token from the account managing
  the project.
- Variable `NETLIFY_SITE_ID`: `0a290ce5-3f4b-4541-bfe5-ef80a242e29b`, the existing
  project's ID.

The jobs use the existing `production` and `preview` GitHub environments and the
same trusted-maintainer model as API deployments. Deployment credentials are only
available to branch-push deployment jobs, not PR validation jobs.

Keep the project’s Git integration disconnected and allow CLI deployments.

CI builds and tests on Node.js 26. The function bundle targets Node.js 24.
Sharp and the SVG sanitizer stay external so Netlify includes their native
binaries and WASM files. GitHub’s Linux runner packages these dependencies.

### Runtime variables

Set these five variables through Netlify's dashboard, CLI or API, available to the
function runtime:

```dotenv
EXTENSION_PACKAGE_PROCESSOR_SECRET=<shared-with-the-API>
EXTENSION_PACKAGES_S3_ENDPOINT=https://s3.<region>.backblazeb2.com
EXTENSION_PACKAGES_S3_BUCKET=fb-extensions-packages
EXTENSION_PACKAGES_S3_ACCESS_KEY_ID=<bucket-restricted-keyID>
EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY=<applicationKey>
```

Set production values specifically for **Production**. Set preview values for
**Branch deploys**: `fb-extensions-packages-preview`, its own restricted B2 key and
a separate shared secret. CLI aliases use this context, not Netlify's Git-based
**Deploy Previews** context. Do not put production credentials in **All deploy
contexts**, where previews could inherit them.

The B2 adapter derives the signing region from the standard endpoint. No separate
region variable is needed. The API and package processor must use the same bucket and
shared secret within each environment. All branch previews share the preview
bucket; development uses local storage, with no development B2 bucket.
Do not provide public asset bucket credentials, D1 credentials or API administration
tokens. Runtime variables do not come from `netlify.toml`; redeploy after changing them.

Configure each API environment with its matching dashboard-managed
`EXTENSION_PACKAGE_PROCESSOR_URL` and `EXTENSION_PACKAGE_PROCESSOR_SECRET`:

- Production: `https://fb-api-packager.netlify.app/.netlify/functions/extension-package-processor`.
- Preview: `https://staging--fb-api-packager.netlify.app/.netlify/functions/extension-package-processor`.

A branch API can use its matching package processor alias for testing a change to both
services; otherwise it uses fixed staging. The HTTP adapter requires HTTPS in
production and allows loopback HTTP for local development.
The function must be reachable by the API without a Netlify browser login; its
bearer secret authenticates processing requests.

Deploying the package processor does not enable API package processing. Keep
`EXTENSION_PACKAGES_MODE=disabled` in the API's `services/api/wrangler.jsonc` for
production and Previews until storage, runtime and end-to-end verification are
complete. This setting is not a Netlify runtime variable.

## Processing and recovery

The API retains D1 ownership checks, job leases, immutable source/artifact records,
and publication. The processor handles ZIP validation, manifest extraction and
image preparation.

The API reserves bounded private B2 output keys before invoking `PackageProcessor`.
The processor reads the uploaded ZIP and stores the validated bytes unchanged
alongside any temporary display icons in the private package bucket. Requests and
responses pass metadata and object keys to stay within function payload limits.
The API then creates/reuses the permanent extension draft, copies the prepared
icons to their public UUID paths, records the artifact, and deletes temporary icons.
The processor uses only package bucket credentials.

Output reservations use the maximum object size until processing succeeds; the
archive reservation then shrinks to its actual size. Unused icon reservations are
removed after successful publication to the asset bucket. Failed or interrupted
outputs remain tracked for normal cleanup, including a runner whose response was
lost after it wrote to B2.

This is a regular synchronous function. The API’s Durable Object dispatcher waits
for the completed response before recording the final job status. Do not
use Netlify background-function mode, which returns 202 before processing completes.
The package processor deadline is 45 seconds, the HTTP client timeout is 50 seconds, and the
Netlify synchronous limit is 60 seconds. Invalid ZIPs and icons return 422; transport
failures, timeouts and unavailable storage return retryable 503 errors. Existing API
attempt limits and lease recovery apply.

Production package processing remains disabled in `services/api/wrangler.jsonc`.
Before enablement, verify the Netlify deployment, measure runtime and credit usage,
and repeat the controlled production package test, including near-limit ZIPs,
SVG and raster icons, pending ZIP replacements, approval and cleanup.
