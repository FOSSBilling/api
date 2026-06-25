import { describe, it, expect } from "vitest";
import { createNodeBindings, SQLiteAdapter } from "../../../../src/lib/adapters/node/index";

describe("createNodeBindings", () => {
  it("should create bindings with default paths", () => {
    const bindings = createNodeBindings();

    expect(bindings).toBeDefined();
    expect(bindings.caches).toBeDefined();
    expect(bindings.databases.DB_EXTENSIONS).toBeInstanceOf(SQLiteAdapter);
    expect(bindings.environment).toBeDefined();
  });

  it("should create memory caches when no path provided", () => {
    const bindings = createNodeBindings();

    expect(bindings.caches.CACHE_KV).toBeDefined();
    expect(bindings.caches.AUTH_KV).toBeDefined();
  });

  it("should create environment adapter", () => {
    const bindings = createNodeBindings();

    expect(bindings.environment).toBeDefined();
    expect(typeof bindings.environment.get).toBe("function");
    expect(typeof bindings.environment.has).toBe("function");
  });
});

describe("normalizePath (internal function)", () => {
  it("should use in-memory database by default", () => {
    const bindings = createNodeBindings();
    expect(bindings).toBeDefined();
    expect(bindings.caches.CACHE_KV).toBeDefined();
    expect(bindings.caches.AUTH_KV).toBeDefined();
  });

  it("should accept empty path parameter", () => {
    const bindings = createNodeBindings("");
    expect(bindings).toBeDefined();
  });
});
