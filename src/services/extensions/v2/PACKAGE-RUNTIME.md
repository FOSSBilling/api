# Package runtime validation

Package preparation accepts ready-to-install ZIPs. The directory never runs
uploaded code, compilers, dependency installation or package build scripts.

The HTTP endpoint validates the bounded request, stores the upload privately and
returns a job ID. The queue consumer validates ZIP entries, copies their existing
compressed payloads, replaces the manifest and prepares the display icon.

## Local checks

The standalone demo uses the real Wrangler queue consumer with local D1 and R2:

```sh
npm run packages:setup
npm run packages:dev
# In a second terminal:
npm run packages:demo -- --fresh
```

A fresh run verifies private job status, package and icon access before approval,
owner preview security headers, review and approval, the public ZIP checksum and
icon, and a private manifest correction using the stored source.

Worker and Node tests additionally cover archive limits and corruption, queue
retries and duplicate delivery, interrupted leases, ownership changes and
publisher revocation. The directory tests cover the private job proxy and polling
failures; publisher tests cover completion, rejection and the polling deadline.

## Before production enablement

Measure admission and consumer invocations separately: CPU and wall duration,
memory failures, queue delay, retries, and storage/image-service latency. Include
near-limit ZIPs and SVG/raster icons. The consumer is configured for one message
at a time with concurrency one.

Local functional tests and earlier process-CPU benchmarks do not establish
production capacity or billing.
