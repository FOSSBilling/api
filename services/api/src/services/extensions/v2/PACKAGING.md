# Directory-built packages

Authors upload ready-to-install distribution ZIPs, with any compilation already
complete. The API validates and repacks them with directory-generated manifests,
then publishes them through the existing revision review. It never runs uploaded
code or package build scripts. ZIPs use the private B2 bucket; prepared icons use
the public asset bucket, including icons for pending submissions. Automated tests
use the B2 adapter with mocked S3 responses.
Package routes are disabled by default. Local development and production enablement are separate modes.

## Local development and testing

Run `npm run dev` and `npm run extension-packager:dev` in separate terminals at the
repository root. Apply local migrations with `npm run db:migrate:all:local`.
The API's normal `.dev.vars` is still used for authentication; package processing
needs no B2 credentials. Both development commands apply
`libraries/extension-packaging/development.env` after service-specific env files,
deliberately overriding old B2 and packager settings. Other service settings remain
available from `.dev.vars`. The shared settings select development mode, the local
processor and loopback S3/public endpoints.

The API dev command includes a development-only Wrangler configuration that serves
`extension-packages-local` and `extension-assets-local` through the
[local R2 S3 API](https://developers.cloudflare.com/r2/local-development/).
The endpoint is experimental and supported by the pinned Wrangler version. Both
services use the existing S3 adapter; no R2 binding reaches package domain code.
Objects persist under `services/api/.wrangler/state`. Durable Objects and D1 also run
locally. Nothing is uploaded to B2 during development.

Local defaults use API port 8787 and packager port 8790. Local storage is unversioned;
B2 cleanup still requires an explicit version ID. HTTP storage and asset URLs are
accepted only on loopback addresses with `ENVIRONMENT=development`.

Deployed environments use separate private B2 package buckets:

| Environment | Private package bucket           |
| ----------- | -------------------------------- |
| Production  | `fb-extensions-packages`         |
| Preview     | `fb-extensions-packages-preview` |

The API and packager must use the same bucket within each environment. All branch
Previews share the preview bucket. There is no development B2 bucket.

Preview packaging stays disabled (`EXTENSION_PACKAGES_MODE=disabled`) until its
package and asset B2 settings and bucket-restricted keys are configured, together
with the Preview packager URL and shared secret. Set the API's Preview runtime
values in **Previews Base** and on existing Previews individually. The packager
setup and B2 variable names are documented below.

From the repository root, `npm test` covers the package lifecycle through the real API routes and
D1 repository, with mocked S3 responses and prepared image fixtures. Node tests
also exercise package preparation and B2 storage without a Cloudflare runtime.

## API and review

The OpenAPI reference is available at `/extensions/v2/docs`.

- `POST /extensions/v2/package-uploads` accepts a manifest v1 object, the ZIP byte
  count, and a hex SHA-256. It reserves storage quota and returns either an existing
  job or `{ kind: "upload", id, url, headers }` with a five-minute PUT URL. Send the
  raw ZIP to that URL with the returned headers. The HTTP client supplies
  `Content-Length` for the fixed-size body.
- `POST /extensions/v2/packages` accepts JSON `{ upload_id }` to confirm a direct
  upload, or `{ manifest, source_id }` to rebuild a stored source. Confirmation
  checks the stored length and checksum metadata before queuing the job. Both
  paths return **202** with the job and private status URL in `Location`.
  An active owning developer profile is required. Machine publishers need
  `extensions:push` and an active mapped developer binding. Moderators may
  rebuild published stored source for a correction using its `source_id`.
- `GET /extensions/v2/packaging-jobs/{jobId}` returns `queued`, `processing`, `ready`
  or `failed`. Ready jobs include the artifact; failed jobs include an actionable
  error. Reads require the current owning developer/publisher or a moderator,
  and are never publicly cached. Identical requests reuse queued/completed work.
- `GET /extensions/v2/packages/{packageId}` returns the artifact metadata.
  `/download` serves its ZIP and `/icon` serves its prepared display image.
  Before approval, only the current owner and moderators have access. Delisting
  removes public access.
- `POST /extensions/v2/packages/cleanup` lets moderators reclaim unreferenced
  object reservations older than one day.

Releases carry `artifact_id`, `sha256`, the download URL and manifest requirements.
Submission and approval validate these against the stored artifact. The selected
latest release also supplies the overview's version, download, requirements and
manifest-backed metadata. Editing a release requires its stored package or a
source ZIP; the directory always queues package preparation before saving it.

At most one release can have `is_latest: true`. Without a selection, the newest
stable release is used, falling back to a prerelease. The directory's release
editor provides a “Set as Latest Release” checkbox, checked by default for new
stable releases. This flag stays out of the manifest.

## Background processing and provider boundaries

D1 stores the validated manifest, captured owner/profile generation/ownership
epoch, upload reference and processing result. The job processor rechecks account
ownership and machine-publisher revocation before processing. The staged upload
becomes the immutable source object after validation.

A Durable Object alarm dispatches jobs in production, locally and in Cloudflare
Previews. Environments with a dedicated D1 database use the default job scope.
Each Preview assigns a stable scope to its jobs in the shared staging D1 database.
The scope also applies to status reads and request deduplication. Before inserting
a job, the API arms recovery, then requests an immediate wakeup once the job is
saved. The alarm processes one job at a time and schedules the next job, retry,
or expired lease. A 20-minute lease protects against duplicate processing.
Temporary failures retry after a minute, with at most three attempts. Invalid
archives and revoked ownership fail immediately. When packaging is enabled, the
hourly maintenance trigger also wakes the dispatcher to recover pending jobs
and jobs whose processing leases have expired.

`processPackagingJob` takes a `PackagingJobRepository` and a preparation callback.
Package preparation takes a `PackageRepository`, `PackageStore` and
`PackageProcessor`. Cloudflare scheduling and binding adapters live under
`src/lib/adapters/cloudflare/`. The `@fossbilling/extension-packaging` workspace
defines the shared contracts and adapters. The API calls the packager over HTTP
and the Netlify entry point runs the same Node handler used locally. A different
runtime can supply its own scheduler and the same package interfaces.

Jobs interrupted or undelivered for a day are marked expired once no active lease
remains. Terminal jobs are retained for seven days, with at most 256 jobs per owning
account. Cleanup never deletes uploads referenced by active jobs, and detaches
terminal job references before reclaiming abandoned objects. Published artifacts
remain immutable and are not removed with job history.

The directory polls private job status and retains a release-job reference across
reloads. The publisher waits for completion before submitting a revision; failed
or timed-out jobs stop publication, and a retry reuses existing work. Server-side
new submissions and manifest corrections also poll with a bounded wait.

## Storage and rebuilds

Each developer profile generation, extension ID and version has one immutable
source ZIP. Changing any source bytes, including repacking, requires a new
version. Manifest changes produce a new immutable artifact from that source;
directory-only changes such as README edits keep the existing package.
Approval publishes the revision and its artifacts in one D1 transaction. Older
approved artifacts retain their URLs and checksums.

Object reservations precede uploads. Before external processing, the API reserves at most
17 MiB for the archive and 4 MiB for each possible icon; the archive reservation shrinks
to its actual size after processing. This headroom keeps interrupted runner writes
accounted for within the owner's quota. Unique constraints deduplicate concurrent
builds; failed writes remain recorded for cleanup. Cleanup claims unreferenced
objects before deletion, and builds cannot reference claimed objects. The
per-account allowance is 256 objects / 512 MiB, including abandoned reservations
and prepared images. Ready sources and artifacts are retained.

ZIPs must contain ready-to-install files at the root. Packaging replaces the
optional root `manifest.json`. Other files are decompressed for CRC and actual
size validation, then their original compressed payloads are copied unchanged
with normalized ZIP headers. Only the generated manifest is compressed. It never runs
scripts from the archive. Input is limited to 5 MiB, 500 entries and 16 MiB of
actual decompressed data. Upload reservations reject files above 5 MiB.
Paths are limited to 1,024 characters and 32 components.
Encrypted entries, symlinks, unsafe paths, duplicate/colliding names, file/directory
conflicts and corrupt archives are rejected. Checksums cover the final stored ZIP.

## Icons

Include at most one root `icon.svg`, `icon.png`, `icon.webp`, or `icon.avif`.
There is no manifest icon field; packages without an icon use the generic icon.
Packaging prepares display images once and stores them in the configured public asset bucket.
The original icon stays unchanged in the ZIP. A new extension receives its permanent
UUIDv7 draft identity after package validation, before the first icon is stored.
The first review submission reuses that draft identity.

SVGs are sanitized with Cloudflare svg-hush through the pinned `@zeropress/svg-hush`
Node adapter and served directly. SVG inputs are bounded by the ZIP expansion
limit and the sanitizer's built-in input/output limits. Raster inputs use Sharp in the Node packager to produce
AVIF and PNG variants within 256 × 256 pixels, preserving proportions and
transparency without enlarging small images. Raster inputs are limited to 16,777,216 pixels.
Requests prefer SVG when present,
otherwise AVIF when explicitly accepted, with PNG fallback. They read stored
images directly and never reopen a ZIP.

All prepared icons, including pending ones, use
`extensions/<extension UUID>/icons/<asset UUID>.<format>` in the public asset bucket.
One asset UUID identifies all format variants; manifest corrections reuse them.
UUID paths are unlisted, not access control: anyone given the direct URL can read
the image before approval. ZIPs and package metadata remain private until approved.
The API preview route still checks ownership and returns private cache headers,
`nosniff`, and a sandboxed Content Security Policy.

Icons are uploaded during packaging, with immutable public cache headers. An asset
upload failure fails the job; it never switches to another storage backend.
Approval updates the listing to the existing CDN URL and performs no image copy.
The revision ID is checked before changing the listing URL to avoid overwriting a
newer publication.

## Private B2 package storage

Configure the deployed API and packager with their environment's bucket and
bucket-restricted key:

```dotenv
EXTENSION_PACKAGES_S3_ENDPOINT="https://s3.<region>.backblazeb2.com"
EXTENSION_PACKAGES_S3_BUCKET="fb-extensions-packages"
EXTENSION_PACKAGES_S3_ACCESS_KEY_ID="your-keyID"
EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY="your-applicationKey"
```

The B2 adapter derives its signing region from the standard
`https://s3.<region>.backblazeb2.com` endpoint for both packages and assets.
Local R2 uses `auto` internally; no separate region settings are needed.

Keep the bucket private. The API key needs read, write and delete-file permissions;
the packager needs read and write. No public URL or domain is required. Preview
uses its own bucket and credentials. The committed production configuration remains
disabled. An incomplete S3 configuration or upstream failure returns 503 rather than
silently switching storage backends.

Configure [bucket CORS](https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules)
to allow `PUT` from the directory's origin and these request headers:
`Content-Type`, `Cache-Control`, `x-amz-checksum-sha256`, and `x-amz-meta-sha256`.
Use the production directory origin on the production bucket and the directory
Preview origins that need uploads on the preview bucket. Loopback development
origins are handled by the local R2 endpoint. Configure package buckets to keep
only the latest version of each object so repeated PUTs do not retain old versions.

Source and built ZIPs use `packages/<object-id>` inside the environment's private
bucket. A source upload URL is scoped to that key, PUT, a byte count, and its
SHA-256. Treat the URL as a temporary credential. B2 verifies
`x-amz-checksum-sha256` on the signed PUT. The API confirms size and metadata
via HEAD before the packager independently verifies the stored bytes. Reads are
bounded to 17 MiB and downloads still go through the permission-checked API.
Images use the separate public asset bucket and its CDN hostname, including
before approval.

Cleanup identifies the stored B2 version and deletes it explicitly. Deleting only
by name would leave billable versions behind. Failed deletion retains the D1
reservation for retry.

## B2 assets and Cloudflare

Configure these on the deployed API; local development uses its local asset bucket:

```dotenv
EXTENSION_ASSETS_S3_ENDPOINT="https://s3.<region>.backblazeb2.com"
EXTENSION_ASSETS_S3_BUCKET="fb-extensions-assets"
EXTENSION_ASSETS_S3_ACCESS_KEY_ID="your-keyID"
EXTENSION_ASSETS_S3_SECRET_ACCESS_KEY="your-applicationKey"
EXTENSION_ASSETS_PUBLIC_URL="https://extensions-assets.fossbilling.net"
```

Restrict the asset key to this bucket with read, write and delete-file permissions.
Pending API previews read these stored objects; cleanup deletes abandoned versions.
Tests mock S3 responses without accessing a real bucket. Public object keys use
`extensions/<extension UUID>/icons/<asset UUID>.<format>`, for example:

```text
https://extensions-assets.fossbilling.net/extensions/019a0000-0000-7000-8000-000000000001/icons/11111111-1111-4111-8111-111111111111.svg
```

The parent is the extension record's UUID, not its public identifier. The icon
record allocates an immutable asset UUID when its display images are prepared.
All format variants share that identity, and manifest-only edits reuse the same image URL.
A different source gets a new asset UUID. Uploads set
`Cache-Control: public, max-age=31536000, immutable` and retain each file's SHA-256
in object metadata for verification.
Package source records retain the prepared image keys, so retries and metadata
corrections reuse existing images. Directory pages use direct CDN images with AVIF/PNG `<picture>` fallback,
bypassing the directory image transformer.

The bucket is public. The hostname-scoped Cloudflare response-header rule
`extension_assets_security_headers` adds these headers, including on cached
responses:

```text
Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:
X-Content-Type-Options: nosniff
```

Prepared assets enter this bucket during packaging, before approval. Delisting
stops access through the API, but does not revoke direct image URLs or cached copies.
Keep B2 daily caps and alerts configured for download and transaction charges.

## Production configuration (prepared locally)

The top-level Wrangler configuration declares bindings, public URLs and deployment
controls, keeping `EXTENSION_PACKAGES_MODE=disabled`. B2 endpoints and
bucket names are dashboard-managed runtime variables. Configure
these under the Worker's **Settings > Variables and Secrets**, not build settings:

| Runtime variables                                                | Purpose                         |
| ---------------------------------------------------------------- | ------------------------------- |
| `EXTENSION_PACKAGES_S3_ENDPOINT`, `EXTENSION_PACKAGES_S3_BUCKET` | Private ZIP storage connection  |
| `EXTENSION_ASSETS_S3_ENDPOINT`, `EXTENSION_ASSETS_S3_BUCKET`     | Public image storage connection |

`keep_vars: true` preserves these values during Wrangler deployments. Do not
reintroduce them in the committed `vars` map. Keep development values in ignored
`.dev.vars` files; the examples above use placeholders. No production resources
or secrets are created by a local build or type-generation command.

Before deployment (including an automatic deployment after merge):

1. Supply `EXTENSION_PACKAGES_S3_ACCESS_KEY_ID` and
   `EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY` as Worker secrets for
   the private package bucket. Supply separate `EXTENSION_ASSETS_S3_ACCESS_KEY_ID`
   and `EXTENSION_ASSETS_S3_SECRET_ACCESS_KEY` for the public asset bucket.
   Development keys in `.dev.vars` are not production secrets.
2. Configure the packager URL and shared secret described below, confirm the
   scoped CDN security headers remain configured, and keep B2 caps/alerts in place.
3. Apply the package and job tables through the normal D1 deployment workflow.
4. After dispatcher capacity and moderation requirements are agreed, explicitly set
   `EXTENSION_PACKAGES_MODE=enabled` in the reviewed production configuration.
   Verify a production smoke test before enabling the dependent directory and
   modules publisher changes. Those callers require an enabled, configured API;
   merging a disabled API alone does not make package submission available.

Production requires HTTPS download URLs with the `/extensions/v2` base path,
complete credentials for its private package and public asset buckets, a public
asset URL and an authenticated extension packager. An incomplete configuration
fails with 503; it cannot fall back to local ZIP storage. Private package objects
use `packages/<object UUID>` in the bucket selected for that environment.
Public image objects use the UUID-based layout described above.

The disabled mode blocks package reads as well as writes. Once managed releases
are published, disabling it also stops their API downloads and private previews;
it is not an upload-only pause switch. Prepared CDN images remain accessible independently, even for pending packages.

Before enabling package mode, measure admission and alarm invocations
separately. Track CPU and wall duration, memory failures, time from submission
to processing, retries, and storage and packager latency. Include near-limit ZIPs and SVG/raster icons.
Local functional tests do not establish production capacity or billing.

## Extension packager

The API dispatches ZIP and image work to a separately deployed Node service through
an authenticated HTTP adapter. Requests and responses contain metadata and private
B2 object keys, not ZIP bytes. The API retains ownership, leases and publication.

See the [packager setup and deployment guide](../../../../../extension-packager/README.md) for Netlify configuration,
local development, credentials, deadlines and runtime verification. The shared
contracts and portable ZIP implementation live in `libraries/extension-packaging`.
