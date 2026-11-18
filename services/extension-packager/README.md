# Extension packager

A separately deployed Node service for ZIP validation, manifest replacement and icon
preparation. It imports the shared `@fossbilling/extension-packaging` contracts and
implementation; it has no dependency on the API service source, database or Cloudflare
bindings. Netlify's entry point in `netlify/functions/extension-packager.ts` delegates
to the same standard Request/Response handler used locally in `src/handler.ts`.

## Local development

Install dependencies with `npm ci` from the repository root. Start the API and
packager in separate terminals:

```sh
npm run dev
npm run extension-packager:dev
```

The API command also starts Wrangler's local R2 S3 service. Both commands apply
`libraries/extension-packaging/development.env` after service-specific `.dev.vars`
files. This deliberately overrides old B2 and packager settings so normal
development stays local. Other service settings still come from `.dev.vars`.
The API needs its own `.dev.vars` for authentication; the packager needs no B2
credentials or local secret file.

The packager listens on `127.0.0.1:8790`. It reads and writes ZIPs in
`extension-packages-local` through the API's local S3 endpoint on port 8787.
The API stores prepared icons in `extension-assets-local` and serves them locally.
Objects persist in the API's `.wrangler/state` across restarts. These buckets exist
only on your machine; no R2 or B2 bucket is created remotely.

Local S3 uses Wrangler's experimental endpoint, supported by the pinned Wrangler
version. Production continues to use private B2 storage. Ordinary tests mock S3;
the API's local-storage test also exercises the real local R2 endpoint.

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
The Netlify configuration currently selects Node.js 24, a stable Lambda runtime.
[AWS lists Node.js 26 as public preview](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html),
so it is not yet the production hosting target. The code is tested on Node.js 26;
this runtime selection belongs only to the Netlify adapter.

Native Sharp and sanitizer dependencies remain external so Netlify includes their
binaries and WASM files. Verify those files and the deployed runtime before
enabling processing.

Set these five variables through Netlify's dashboard, CLI or API for the function runtime:

```dotenv
EXTENSION_PACKAGER_SECRET=<shared-with-the-API>
EXTENSION_PACKAGES_S3_ENDPOINT=https://s3.<region>.backblazeb2.com
EXTENSION_PACKAGES_S3_BUCKET=fb-extensions-packages
EXTENSION_PACKAGES_S3_ACCESS_KEY_ID=<bucket-restricted-keyID>
EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY=<applicationKey>
```

The B2 adapter derives the signing region from the standard
`https://s3.<region>.backblazeb2.com` endpoint. Local R2 uses `auto` internally;
neither needs a separate region variable.

Keep these production values in the production deploy context. Preview deployments
use `fb-extensions-packages-preview`, its own restricted B2 key and a separate shared
secret. The API and packager must use the same bucket and shared secret within each
environment. All branch Previews share the preview bucket. Development uses local
storage, with no development B2 bucket.
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
