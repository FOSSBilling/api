/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module "cloudflare:test" {
  type ProvidedEnv = CloudflareBindings;
}

// Test-only bindings injected by vitest.config.ts (via readD1Migrations) for
// test/apply-migrations.ts to apply - never part of the real deployed
// Worker's bindings, so deliberately not in worker-configuration.d.ts.
// `env` from "cloudflare:test" is typed as Cloudflare.Env (not ProvidedEnv),
// hence augmenting this namespace directly rather than the module above.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS_EXTENSIONS: import("cloudflare:test").D1Migration[];
    TEST_MIGRATIONS_CENTRAL_ALERTS: import("cloudflare:test").D1Migration[];
  }
}
