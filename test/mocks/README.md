# Test Mocks

This directory contains mock data used across the test suite.

## Contents

- `github-releases.ts` - Mock GitHub API release data

## Usage

Database tests run against a real local D1 (see `@cloudflare/vitest-pool-workers` and `test/utils/apply-migrations.ts`) rather than a mock adapter - see `test/services/extensions/v2/db-fixtures.ts` for seed/read helpers and `test/services/extensions/v2/db-interceptor.ts` for the handful of tests that need to inject a fault or a mid-request race.
