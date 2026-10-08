import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeBindings } from "../../../../src/lib/adapters/node/index";

// The Node bindings exist to prove the IPlatformBindings port is
// implementable off-Cloudflare (see src/lib/adapters/node/index.ts); these
// tests assert that contract, not file-path edge cases.
describe("createNodeBindings", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-node-bindings-"));

  afterAll(() => {
    // SQLite handles may still be open here (see cache.test.ts); removal is
    // best-effort and temp-scoped either way.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore - the directory is under the OS temp dir.
    }
  });

  it("creates in-memory caches and an environment adapter by default", () => {
    const bindings = createNodeBindings();

    expect(bindings.caches.CACHE_KV).toBeDefined();
    expect(bindings.caches.AUTH_KV).toBeDefined();
    expect(typeof bindings.environment.get).toBe("function");
  });

  it("creates file-backed caches when given a path", () => {
    const bindings = createNodeBindings(join(dir, "bindings"));

    expect(bindings.caches.CACHE_KV).toBeDefined();
    expect(bindings.caches.AUTH_KV).toBeDefined();
  });
});
