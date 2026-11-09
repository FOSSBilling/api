# Directory-built packages

Authors upload ready-to-install distribution ZIPs, with any compilation already
complete. The API validates and repacks them with directory-generated manifests,
then publishes them through the existing revision review. It never runs uploaded
code or package build scripts. ZIPs use the private B2 bucket; prepared icons use
the public asset bucket, including icons for pending submissions. Automated tests
inject emulated storage.
Package routes are disabled by default. Local development and production enablement are separate modes.

## Local development and testing

Run the API through the normal `npm run dev` command. Use ignored `.dev.vars`
for local credentials, set `ENVIRONMENT=local` and `EXTENSION_PACKAGES_MODE=local`,
and set `EXTENSION_PACKAGES_BASE_URL` to the local API's `/extensions/v2` URL.
Apply local migrations with `npm run db:migrate:all:local`. The configured Queue
and Images bindings run locally under Wrangler; B2 requests use the configured
buckets and development keys, so use a separate key and package object prefix.

`npm run test:all` covers the package lifecycle through the real API routes and
D1 repository, with emulated storage and images. Node tests also exercise package
preparation and B2 storage without a Cloudflare runtime.

## API and review

The OpenAPI reference is available at `/extensions/v2/docs`.

- `POST /extensions/v2/packages` accepts manifest v1 JSON and either a ready-to-install
  ZIP or an existing `source_id` in a multipart form. It stores the upload privately
  and returns **202** with a job ID, status and private status URL in `Location`.
  An active owning developer profile is required. Machine publishers need
  `extensions:push` and an active mapped developer binding. Moderators may
  rebuild published stored source for a correction, but cannot upload new files
  for another developer.
- `GET /extensions/v2/package-jobs/{jobId}` returns `queued`, `processing`, `ready`
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

## Queue processing and provider boundaries

Queue messages contain only job IDs. D1 stores the validated manifest, captured
owner/profile generation/ownership epoch, upload reference and processing result.
The consumer rechecks account ownership and machine-publisher revocation before
processing. The staged upload becomes the immutable source object after validation,
so it is not uploaded to package storage a second time.

The generic `IMessageQueue` producer interface lives in `src/lib/interfaces.ts`;
`CloudflareQueueAdapter` implements it. `processPackageJob` depends on a
`PackageJobRepository` and a preparation callback, not Cloudflare MessageBatch,
acknowledgements or retry APIs. Package preparation accepts a `PackageRepository`, `PackageStore` and
`PackageImageProcessor`. SQL and guarded writes live in `db/package-builds.ts`;
Cloudflare bindings, queue delivery and image processing live under
`src/lib/adapters/cloudflare/`, and the B2 store lives under `src/lib/adapters/b2/`.
The package workflow contains no Cloudflare binding types or SDK calls. A different
runtime supplies these interfaces and its own queue consumer; the rest of the API
still has existing platform integrations outside this package workflow.

Wrangler declares the production producer/consumer pair; local development emulates it. The
consumer handles one message at a time, with concurrency limited to one. Duplicate
delivery uses a 20-minute processing lease; a busy duplicate is delayed until that
lease can expire. Temporary failures retry after a minute, at most three processing
attempts. Invalid archives and revoked ownership fail immediately. The normal
scheduled handler redispatches unsent or stale jobs; this covers interruption
between saving a job and publishing its queue message. It does not rely on the
browser or the HTTP request remaining connected.

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

Object reservations precede uploads. Unique constraints deduplicate concurrent
builds; failed writes remain recorded for cleanup. Cleanup claims unreferenced
objects before deletion, and builds cannot reference claimed objects. The
per-account allowance is 256 objects / 512 MiB, including abandoned reservations
and prepared images. Ready sources and artifacts are retained.

ZIPs must contain ready-to-install files at the root. Packaging replaces the
optional root `manifest.json`. Other files are decompressed for CRC and actual
size validation, then their original compressed payloads are copied unchanged
with normalized ZIP headers. Only the generated manifest is compressed. It never runs
scripts from the archive. Input is limited to 5 MiB, 500 entries and 16 MiB of
actual decompressed data; multipart requests are capped at 6 MiB before parsing.
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
Workers adapter and served directly. SVG inputs are bounded by the ZIP expansion
limit; there is no separate SVG size cap. Raster inputs use the local `PACKAGE_IMAGES` binding to produce
AVIF and PNG variants within 256 × 256 pixels, preserving proportions and
transparency without enlarging small images. Requests prefer SVG when present,
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

## Private B2 package testing

Set these in the integrated local API's ignored `.dev.vars`. The directory
worktree's root `.dev.vars` may hold the development credentials, but the API
process must receive them in its own configuration file.

```dotenv
EXTENSION_PACKAGES_S3_ENDPOINT="https://s3.<region>.backblazeb2.com"
EXTENSION_PACKAGES_S3_REGION="<region>"
EXTENSION_PACKAGES_S3_BUCKET="your-development-packages-bucket"
EXTENSION_PACKAGES_S3_ACCESS_KEY_ID="your-keyID"
EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY="your-applicationKey"
EXTENSION_PACKAGES_S3_PREFIX="local"
```

Keep this bucket private. Use a separate development key restricted to the bucket
with read, write and delete-file permissions. No public URL or domain is required.
Use `EXTENSION_PACKAGES_MODE=local` only outside production. The committed production configuration remains disabled.
The tests inject a local R2 store when S3 endpoints are unset. Normal local development
uses B2 with development credentials. An incomplete S3 configuration or upstream
failure returns 503 rather than silently switching storage backends.

R2 validates the supplied SHA-256 when writing and returns that checksum as
object metadata. Its adapter checks this metadata on reads without rehashing the
response body. The B2 adapter additionally hashes the downloaded bytes.

Source and built ZIPs use `local/packages/<object-id>`. Object IDs are allocated
once by D1 before upload. Uploads carry a signed SHA-256 payload and private cache
headers. Reads are bounded to 17 MiB and verify artifact bytes before returning a
ZIP through the existing permission-checked download route. B2 URLs and credentials
are never returned to visitors. Images use the separate public asset bucket and
its CDN hostname, including before approval.

Cleanup identifies the stored B2 version and deletes it explicitly. Deleting only
by name would leave billable versions behind. Failed deletion retains the D1
reservation for retry.

## B2 asset and Cloudflare testing

Add these to the local API's ignored `.dev.vars`:

```dotenv
EXTENSION_ASSETS_S3_ENDPOINT="https://s3.<region>.backblazeb2.com"
EXTENSION_ASSETS_S3_REGION="<region>"
EXTENSION_ASSETS_S3_BUCKET="your-development-assets-bucket"
EXTENSION_ASSETS_S3_ACCESS_KEY_ID="your-keyID"
EXTENSION_ASSETS_S3_SECRET_ACCESS_KEY="your-applicationKey"
EXTENSION_ASSETS_PUBLIC_URL="https://extensions-assets.fossbilling.net"
```

Restrict the asset key to this bucket with read, write and delete-file permissions.
Pending API previews read these stored objects; cleanup deletes abandoned versions.
Tests can inject emulated storage when the endpoint is unset. Public object keys use
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
controls, keeping `EXTENSION_PACKAGES_MODE=disabled`. B2 endpoints, regions, bucket
names and the package prefix are dashboard-managed runtime variables. Configure
these under the Worker's **Settings > Variables and Secrets**, not build settings:

| Runtime variables                                                                                | Purpose                                                              |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `EXTENSION_PACKAGES_S3_ENDPOINT`, `EXTENSION_PACKAGES_S3_REGION`, `EXTENSION_PACKAGES_S3_BUCKET` | Private ZIP storage connection                                       |
| `EXTENSION_PACKAGES_S3_PREFIX`                                                                   | ZIP object prefix; production requires an explicit non-`local` value |
| `EXTENSION_ASSETS_S3_ENDPOINT`, `EXTENSION_ASSETS_S3_REGION`, `EXTENSION_ASSETS_S3_BUCKET`       | Public image storage connection                                      |

`keep_vars: true` preserves these values during Wrangler deployments. Do not
reintroduce them in the committed `vars` map. Keep development values in ignored
`.dev.vars` files; the examples above use placeholders. No production resources
or secrets are created by a local build or type-generation command.

Before deployment (including an automatic deployment after merge):

1. Provision the `extension-packages` Queue. No R2 image bucket is needed;
   ZIPs use private B2 and prepared icons use the public B2 asset bucket.
   The queue binding must exist even while package mode is disabled; that flag blocks
   application routes, not deployment-time binding validation.
2. Supply `EXTENSION_PACKAGES_S3_ACCESS_KEY_ID` and
   `EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY` as Worker secrets for
   the private package bucket. Supply separate `EXTENSION_ASSETS_S3_ACCESS_KEY_ID`
   and `EXTENSION_ASSETS_S3_SECRET_ACCESS_KEY` for the public asset bucket.
   Development keys in `.dev.vars` are not production secrets.
3. Confirm the Images binding is enabled for the account, the scoped CDN security
   headers remain configured, and B2 caps/alerts are in place.
4. Apply the package and job tables through the normal D1 deployment workflow.
5. After queue-consumer capacity and moderation requirements are agreed, explicitly set
   `EXTENSION_PACKAGES_MODE=enabled` in the reviewed production configuration.
   Verify a production smoke test before enabling the dependent directory and
   modules publisher changes. Those callers require an enabled, configured API;
   merging a disabled API alone does not make package submission available.

Production requires HTTPS download URLs with the `/extensions/v2` base path,
complete credentials for both B2 buckets, an explicit non-`local` ZIP object prefix,
a public asset URL and the Images binding. An incomplete configuration fails with 503;
it cannot fall back to local ZIP storage. Private package objects use the configured prefix.
Public image objects use the UUID-based layout described above.

The disabled mode blocks package reads as well as writes. Once managed releases
are published, disabling it also stops their API downloads and private previews;
it is not an upload-only pause switch. Prepared CDN images remain accessible independently, even for pending packages.

Local validation and the remaining production measurements are summarized in
[PACKAGE-RUNTIME.md](PACKAGE-RUNTIME.md). Local queue success does not establish
production CPU, memory or latency limits.
