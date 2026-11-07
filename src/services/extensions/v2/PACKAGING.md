# Directory-built packages

Authors upload ready-to-install distribution ZIPs, with any compilation already
complete. The API validates and repacks them with directory-generated manifests,
then publishes them through the existing revision review. It never runs uploaded
code or package build scripts. Package storage uses the private B2 bucket when configured, otherwise Wrangler's local R2 emulator. Pending images continue to use the private image binding.
Package routes are disabled by default. Local development and production enablement are separate modes.

## Run the local demo

Use Node.js 24, install dependencies with `npm ci`, then:

```sh
npm run packages:setup
npm run packages:dev
```

In another terminal:

```sh
npm run packages:demo -- --fresh
```

Setup creates an ignored `.dev.vars.packages-local`, applies local migrations,
and seeds a developer and reviewer. Data lives in `.wrangler/package-demo`;
the API listens on port 8789. The demo uploads a synthetic module, checks private
access, submits and approves it, verifies the public download checksum, and
builds a manifest correction from the stored source. `--fresh` allocates a new
extension ID and includes an SVG icon, so private access is checked before any
publication. It also verifies anonymous job-status denial, owner preview headers,
and public icon access after approval. Without `--fresh`, the original no-icon
fixture is repeatable and reuses artifacts.

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
acknowledgements or retry APIs. The D1 repository and Cloudflare consumer wire the
existing storage/image implementation into that lifecycle. Node tests exercise
processing through in-memory implementations without a Cloudflare runtime.
This keeps the new job lifecycle portable; existing D1 and Images integrations
would still need their own adapters for a complete provider migration.

Production and local configurations each declare a producer/consumer pair. The
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
Packaging prepares display images once in `EXTENSION_IMAGE_BUCKET`, shared by
all artifacts using the same source. The original icon stays unchanged in the ZIP.

SVGs are sanitized with Cloudflare svg-hush through the pinned `@zeropress/svg-hush`
Workers adapter and served directly. SVG inputs are bounded by the ZIP expansion
limit; there is no separate SVG size cap. Raster inputs use the local `PACKAGE_IMAGES` binding to produce
AVIF and PNG variants within 256 × 256 pixels, preserving proportions and
transparency without enlarging small images. Requests prefer SVG when present,
otherwise AVIF when explicitly accepted, with PNG fallback. They read stored
images directly and never reopen a ZIP.

Pending previews use the private image route with authorization, private cache
headers, `nosniff`, and a sandboxed Content Security Policy. They are never copied
to public B2. After approval, a background publication job copies the selected
icon to B2, then updates the published listing to its direct CDN URL. A failed
copy retains the existing image route; subsequent published-image reads retry.
The revision ID is checked before changing the listing URL, so a slow copy
cannot overwrite a newer publication.

## Private B2 package testing

Set these in the integrated local API's ignored `.dev.vars`. The directory
worktree's root `.dev.vars` may hold the development credentials, but the API
process must receive them in its own configuration file. The standalone demo
uses `.dev.vars.packages-local`.

```dotenv
EXTENSION_PACKAGES_S3_ENDPOINT="https://s3.eu-central-003.backblazeb2.com"
EXTENSION_PACKAGES_S3_REGION="eu-central-003"
EXTENSION_PACKAGES_S3_BUCKET="fb-extensions-packages"
EXTENSION_PACKAGES_S3_ACCESS_KEY_ID="your-keyID"
EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY="your-applicationKey"
EXTENSION_PACKAGES_S3_PREFIX="local"
```

Keep this bucket private. Use a separate development key restricted to the bucket
with read, write and delete-file permissions. No public URL or domain is required.
Use `EXTENSION_PACKAGES_MODE=local` only outside production. The committed production configuration remains disabled.
With no S3 endpoint, ZIPs use the local R2 binding. An incomplete S3 configuration
or upstream failure returns 503 rather than silently switching storage backends.

R2 validates the supplied SHA-256 when writing and returns that checksum as
object metadata. Its adapter checks this metadata on reads without rehashing the
response body. The B2 adapter additionally hashes the downloaded bytes.

Source and built ZIPs use `local/packages/<object-id>`. Object IDs are allocated
once by D1 before upload. Uploads carry a signed SHA-256 payload and private cache
headers. Reads are bounded to 17 MiB and verify artifact bytes before returning a
ZIP through the existing permission-checked download route. B2 URLs and credentials
are never returned to visitors. Images still use the separate private image
binding, with only approved display images copied to the public asset bucket.

Cleanup identifies the stored B2 version and deletes it explicitly. Deleting only
by name would leave billable versions behind. Failed deletion retains the D1
reservation for retry.

## B2 and Cloudflare testing

Add these to the local API's ignored `.dev.vars` (use
`.dev.vars.packages-local` for the standalone API demo):

```dotenv
EXTENSION_ASSETS_S3_ENDPOINT="https://s3.eu-central-003.backblazeb2.com"
EXTENSION_ASSETS_S3_REGION="eu-central-003"
EXTENSION_ASSETS_S3_BUCKET="fb-extensions-assets"
EXTENSION_ASSETS_S3_ACCESS_KEY_ID="your-keyID"
EXTENSION_ASSETS_S3_SECRET_ACCESS_KEY="your-applicationKey"
EXTENSION_ASSETS_PUBLIC_URL="https://extensions-assets.fossbilling.net"
EXTENSION_ASSETS_S3_PREFIX="local"
```

An unset endpoint disables B2 publication. Test images use `local/icons/`;
production can select a separate prefix. URLs include an immutable image identity,
and uploads set `Cache-Control: public, max-age=31536000, immutable`. Raster
identities include both variant hashes so AVIF and PNG can share a URL stem.
The API checks existing objects before uploading and caches successful checks in
KV. Directory pages use direct CDN images with AVIF/PNG `<picture>` fallback,
bypassing the directory image transformer.

The bucket is public. The hostname-scoped Cloudflare response-header rule
`extension_assets_security_headers` adds these headers, including on cached
responses:

```text
Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:
X-Content-Type-Options: nosniff
```

Only approved assets enter this bucket. Delisting stops access through the API,
but does not revoke previously published public image URLs or cached copies.
Keep B2 daily caps and alerts configured for download and transaction charges.

## Production configuration (prepared locally)

The top-level Wrangler configuration names the production resources but keeps
`EXTENSION_PACKAGES_MODE=disabled`. No production resources or secrets are
created by a local build or type-generation command.

Before deployment (including an automatic deployment after merge):

1. Provision the `extension-packages` Queue and the private R2 bucket `fb-extensions-private-images` used by
   `EXTENSION_IMAGE_BUCKET`. Do not attach a public domain or enable public R2
   access. This stores prepared pending icons; ZIPs remain in private B2.
   The bindings must exist even while package mode is disabled; that flag blocks
   application routes, not deployment-time binding validation.
2. Supply `EXTENSION_PACKAGES_S3_ACCESS_KEY_ID` and
   `EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY` as Worker secrets for
   `fb-extensions-packages`. Supply separate `EXTENSION_ASSETS_S3_ACCESS_KEY_ID`
   and `EXTENSION_ASSETS_S3_SECRET_ACCESS_KEY` for `fb-extensions-assets`.
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
complete private B2 credentials, an explicit non-`local` object prefix, private
image storage and the Images binding. An incomplete configuration fails with 503;
it cannot fall back to local ZIP storage. Both B2 buckets use the `production`
prefix in this configuration. Existing local objects keep the `local` prefix.

The disabled mode blocks package reads as well as writes. Once managed releases
are published, disabling it also stops their API downloads and private previews;
it is not an upload-only pause switch. Public CDN images already published remain
accessible independently.

Local validation and the remaining production measurements are summarized in
[PACKAGE-RUNTIME.md](PACKAGE-RUNTIME.md). Local queue success does not establish
production CPU, memory or latency limits.
