import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Read migrations at config time (Node) so they can be applied inside the
// Workers runtime by test/apply-migrations.ts (a setupFiles script) -
// Miniflare provisions the D1 bindings declared in wrangler.jsonc but
// doesn't run their migrations_dir automatically. Top-level await (Vite
// config files are ESM) avoids fighting defineConfig's overload typing for
// an async factory function.
const extensionsMigrations = await readD1Migrations(
  path.join(import.meta.dirname, "src/services/extensions/v2/db/migrations")
);
const centralAlertsMigrations = await readD1Migrations(
  path.join(import.meta.dirname, "src/services/central-alerts/v1/db/migrations")
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Add test environment variables
        bindings: {
          GITHUB_TOKEN: "test-github-token",
          UPDATE_TOKEN: "test-update-token",
          ASSERTION_SIGNING_SECRET: "test-assertion-signing-secret",
          TEST_MIGRATIONS_EXTENSIONS: extensionsMigrations,
          TEST_MIGRATIONS_CENTRAL_ALERTS: centralAlertsMigrations
        }
      }
    })
  ],
  test: {
    // Deliberately NOT using `setupFiles` for migrations: importing
    // anything from "cloudflare:test" inside a setupFiles script breaks
    // vi.mock() for unrelated test files in this version of
    // @cloudflare/vitest-pool-workers (confirmed empirically - even an
    // unused import of createExecutionContext there made GitHub API mocks
    // in unrelated versions/v1 tests fall through to real network calls).
    // Instead, test/utils/apply-migrations.ts exports a function each test
    // file that touches DB_EXTENSIONS/DB_CENTRAL_ALERTS calls itself from
    // its own beforeAll, which works fine since the import then lives in
    // the test file's own module graph rather than a separate setupFiles one.

    // Exclude Node.js tests from Cloudflare Workers environment
    exclude: [
      "**/node_modules/**",
      "**/test/lib/adapters/node/**",
      "**/test/services/extensions/v2/migrations.test.ts"
    ],

    // Test timeout configuration
    testTimeout: 30000, // 30 seconds max per test
    hookTimeout: 30000, // 30 seconds max for hooks (beforeEach, afterEach)

    // Code coverage configuration
    // Note: Native V8 coverage is not supported with @cloudflare/vitest-pool-workers
    // Must use instrumented Istanbul coverage instead per Cloudflare documentation
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json", "html"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80
      },
      include: ["src/**", "test/**/*.test.ts"],
      exclude: ["src/lib/adapters/node/**"]
    }
  }
});
