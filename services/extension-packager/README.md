# Extension packager

A separately deployed Node service for ZIP validation, manifest replacement and icon
preparation. It imports the shared `@fossbilling/extension-packaging` contracts and
implementation; it has no dependency on the API service source, database or Cloudflare
bindings. Netlify's entry point in `netlify/functions/extension-packager.ts` delegates
to the same standard Request/Response handler used locally in `src/handler.ts`.

## Local development

Install dependencies with `npm ci` from the repository root. Put development settings
in the ignored `services/extension-packager/.dev.vars` file. It needs:

```dotenv
EXTENSION_PACKAGER_SECRET=local-shared-secret
EXTENSION_PACKAGES_S3_ENDPOINT=https://s3.example.invalid
EXTENSION_PACKAGES_S3_REGION=development-region
EXTENSION_PACKAGES_S3_BUCKET=development-bucket
EXTENSION_PACKAGES_S3_PREFIX=local
EXTENSION_PACKAGES_S3_ACCESS_KEY_ID=development-key
EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY=development-secret
```

Use the actual development bucket settings locally, matching the API's private bucket
and object prefix. Configure `services/api/.dev.vars` with
`EXTENSION_PACKAGER_URL=http://127.0.0.1:8790/process` and the same shared secret.
The public asset bucket credentials remain configured only on the API.

From the repository root:

```sh
npm run extension-packager:dev
npm test --workspace @fossbilling/extension-packager
```

The server listens on `127.0.0.1:8790`; `EXTENSION_PACKAGER_PORT` can override the port.
Tests use simulated S3 responses and do not touch live B2 buckets.

## Netlify deployment

Create a dedicated Netlify project connected to this repository:

- Base directory: leave unset to install from the repository root and its lockfile.
- Package directory: `services/extension-packager`.
- Build command: leave blank; Netlify bundles the function automatically.
- Configuration: `services/extension-packager/netlify.toml`.
- Publish directory: `services/extension-packager/netlify/public` (empty placeholder).
- Functions directory: `services/extension-packager/netlify/functions`.

Paths in `netlify.toml` are relative to the repository-root base directory, following
[Netlify's monorepo configuration](https://docs.netlify.com/build/configure-builds/monorepos/).
The config selects Node.js 24 and keeps the native Sharp and sanitizer dependencies
external so Netlify includes their binaries and WASM files. Verify these files and
Node.js 24 in the deployed artifact/runtime before enabling processing.

Set the seven variables listed above through Netlify's dashboard, CLI or API for the
function runtime. Use production credentials and a separate randomly generated shared
secret for production. Keep production values in the production deploy context.
Do not provide public asset bucket credentials, D1 credentials or API administration
tokens. Netlify runtime variables do not come from `netlify.toml`; redeploy after changing them.

After deployment, set the API's dashboard-managed `EXTENSION_PACKAGER_URL` to
`https://<project>.netlify.app/.netlify/functions/extension-packager`, and set its
`EXTENSION_PACKAGER_SECRET` to the same secret. The HTTP adapter requires
HTTPS in production and allows loopback HTTP for local development.

Deploying this project only deploys the packager and its imported code. It does not
start or deploy the API. A Git-connected project can redeploy its configured branch
independently of the API's GitHub Actions deployment.

## Processing and recovery

The API retains D1 ownership checks, job leases, immutable source/artifact records,
and publication. ZIP validation, manifest replacement and image preparation run
outside Workers Free. The API has no inline-processing fallback.

The API reserves bounded private B2 output keys before invoking `PackageProcessor`.
The runner reads the source and writes the resulting ZIP and temporary prepared
icons directly to the private package bucket. Requests and responses contain only
metadata, not ZIP bytes, avoiding function request/response size limits.
The API then creates/reuses the permanent extension draft, copies the prepared
icons to their public UUID paths, records the artifact, and deletes temporary icons.
No ZIP is reopened to serve an icon. The runner needs no D1 credentials or public
asset bucket key.

Output reservations use the maximum object size until processing succeeds; the
archive reservation then shrinks to its actual size. Unused icon reservations are
removed after successful publication to the asset bucket. Failed or interrupted
outputs remain tracked for normal cleanup, including a runner whose response was
lost after it wrote to B2.

This is a regular synchronous function. The existing API Queue provides background
delivery and waits for the completed response before acknowledging the job. Do not
use Netlify background-function mode, which returns 202 before processing completes.
The packager deadline is 45 seconds, the HTTP client timeout is 50 seconds, and the
Netlify synchronous limit is 60 seconds. Invalid ZIPs and icons return 422; transport
failures, timeouts and unavailable storage return retryable 503 errors. Existing API
attempt limits and lease recovery apply.

Production package processing remains disabled in `services/api/wrangler.jsonc`.
Before enablement, verify the Netlify deployment, measure runtime and credit usage,
and repeat the controlled production package test, including near-limit ZIPs,
SVG/raster icons, stored-source rebuilds, approval and cleanup.
