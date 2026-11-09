# Package runtime validation

Package preparation accepts ready-to-install ZIPs. The directory never runs
uploaded code, compilers, dependency installation or package build scripts.

The HTTP endpoint validates the bounded request, stores the upload privately and
returns a job ID. The queue consumer validates ZIP entries, copies their existing
compressed payloads, replaces the manifest and prepares the display icon.

## Local checks

Run `npm run test:all`. Worker tests cover the API routes, guarded D1 writes,
archive limits and corruption, ownership changes, publisher revocation, private
previews, approval and cleanup. Storage and image bindings are emulated for these
tests. Node tests exercise package preparation and job processing through their
interfaces, plus the B2 adapter's request and integrity checks.

The directory tests cover the private job proxy and polling failures; publisher
tests cover completion, rejection and the polling deadline.

## Real B2 smoke test

A local Worker smoke test against both real B2 buckets on 7 November 2026
verified pending SVG/AVIF/PNG CDN delivery, checksums, security headers and cache
hits. Approval and manifest corrections reused existing images. Cleanup removed
abandoned object versions while preserving referenced objects. Test objects and
CDN cache entries were removed afterward. No Worker deployment or production
database changes were made.

## Before production enablement

Measure admission and consumer invocations separately: CPU and wall duration,
memory failures, queue delay, retries, and storage/image-service latency. Include
near-limit ZIPs and SVG/raster icons. The consumer is configured for one message
at a time with concurrency one.

Local functional tests and earlier process-CPU benchmarks do not establish
production capacity or billing.
