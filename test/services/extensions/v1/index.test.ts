import { describe, it, expect, beforeEach } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../../../src/app";

type ExtensionRow = {
  id: string;
  type: string;
  name: string;
  description: string;
  author: string;
  releases: string;
  website: string;
  license: string;
  icon_url?: string;
  readme: string;
  source: string;
  version: string;
  download_url: string;
};

const testExtensions: ExtensionRow[] = [
  {
    id: "Example",
    type: "mod",
    name: "Example Module",
    description: "An example module for developers.",
    author: JSON.stringify({
      type: "organization",
      name: "fossbilling",
      id: "fossbilling",
      URL: "https://fossbilling.org"
    }),
    releases: JSON.stringify([
      {
        tag: "0.0.5",
        date: "2024-02-12T06:36:38+00:00",
        download_url:
          "https://github.com/FOSSBilling/example-module/releases/download/0.0.5/Example.zip",
        changelog_url:
          "https://github.com/FOSSBilling/example-module/releases/tag/0.0.5",
        min_fossbilling_version: "0.6"
      },
      {
        tag: "0.0.4",
        date: "2023-09-25T07:36:29Z",
        download_url:
          "https://github.com/FOSSBilling/example-module/releases/download/0.0.4/Example.zip",
        changelog_url:
          "https://github.com/FOSSBilling/example-module/releases/tag/0.0.4",
        min_fossbilling_version: "0.5"
      }
    ]),
    website: "https://fossbilling.org",
    license: JSON.stringify({ name: "Apache 2.0", URL: "https://www.apache.org/licenses/LICENSE-2.0" }),
    icon_url: "https://raw.githubusercontent.com/FOSSBilling/example-module/main/src/icon.svg",
    readme: "# Example module\n\nThis is an example module.",
    source: JSON.stringify({ type: "github", repo: "FOSSBilling/example-module" }),
    version: "0.0.5",
    download_url:
      "https://github.com/FOSSBilling/example-module/releases/download/0.0.5/Example.zip"
  },
  {
    id: "TestTheme",
    type: "theme",
    name: "Test Theme",
    description: "A test theme.",
    author: JSON.stringify({
      type: "organization",
      name: "fossbilling",
      id: "fossbilling",
      URL: "https://fossbilling.org"
    }),
    releases: JSON.stringify([
      {
        tag: "1.0.0",
        date: "2024-01-01T00:00:00Z",
        download_url: "https://example.com/TestTheme.zip",
        min_fossbilling_version: "0.6"
      }
    ]),
    website: "https://fossbilling.org",
    license: JSON.stringify({ name: "MIT" }),
    readme: "# Test Theme",
    source: JSON.stringify({ type: "github", repo: "FOSSBilling/test-theme" }),
    version: "1.0.0",
    download_url: "https://example.com/TestTheme.zip"
  }
];

function makeD1Mock(): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      let boundParams: unknown[] = [];

      const stmt: D1PreparedStatement = {
        bind(...params: unknown[]) {
          boundParams = params;
          return stmt;
        },

        async all<T = unknown>(): Promise<D1Result<T>> {
          let rows = [...testExtensions];

          if (query.includes("WHERE type = ?") && boundParams[0]) {
            rows = rows.filter((r) => r.type === boundParams[0]);
          }

          return {
            success: true,
            results: rows as unknown as T[],
            meta: {
              duration: 0,
              last_row_id: 0,
              changes: 0,
              served_by: "mock",
              size_after: 0,
              rows_read: rows.length,
              rows_written: 0,
              changed_db: false
            }
          };
        },

        async first<T = unknown>(): Promise<T | null> {
          if (query.includes("LOWER(id) = LOWER(?)") && boundParams[0]) {
            const id = String(boundParams[0]).toLowerCase();
            const found = testExtensions.find(
              (r) => r.id.toLowerCase() === id
            );
            return (found as unknown as T) ?? null;
          }
          return null;
        },

        raw: (() => { throw new Error("not implemented"); }) as D1PreparedStatement["raw"],

        async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
          return {
            success: true,
            results: [],
            meta: {
              duration: 0,
              last_row_id: 0,
              changes: 0,
              served_by: "mock",
              size_after: 0,
              rows_read: 0,
              rows_written: 0,
              changed_db: false
            }
          };
        }
      };

      return stmt;
    },

    dump(): Promise<ArrayBuffer> {
      throw new Error("not implemented");
    },
    batch<T = unknown>(_statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      throw new Error("not implemented");
    },
    exec(_query: string): Promise<D1ExecResult> {
      throw new Error("not implemented");
    },
    withSession(_constraintOrBookmark?: string): D1DatabaseSession {
      throw new Error("not implemented");
    }
  };
}

describe("Extensions API v1", () => {
  beforeEach(() => {
    env.DB_EXTENSIONS = makeD1Mock();
  });

  describe("GET /list", () => {
    it("should return all extensions", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/list", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const data = await res.json() as { result: unknown[] };
      expect(Array.isArray(data.result)).toBe(true);
      expect(data.result.length).toBe(2);
    });

    it("should filter by type", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/list?type=mod", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const data = await res.json() as { result: Array<{ type: string }> };
      expect(data.result.every((e) => e.type === "mod")).toBe(true);
      expect(data.result.length).toBe(1);
    });

    it("should redirect trailing slash", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/list/", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(301);
    });

    it("should parse releases in descending order", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/list", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const data = await res.json() as { result: Array<{ id: string; releases: Array<{ tag: string }> }> };
      const example = data.result.find((e) => e.id === "Example");
      expect(example).toBeTruthy();
      expect(example!.releases[0].tag).toBe("0.0.5");
    });
  });

  describe("GET /:id", () => {
    it("should return a single extension", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/Example", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const data = await res.json() as { result: { id: string; name: string } };
      expect(data.result.id).toBe("Example");
      expect(data.result.name).toBe("Example Module");
    });

    it("should do case-insensitive lookup", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/example", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const data = await res.json() as { result: { id: string } };
      expect(data.result.id).toBe("Example");
    });

    it("should return 500 for unknown extension", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/nonexistent", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(500);
      const data = await res.json() as { error: { message: string } };
      expect(data.error.message).toContain("nonexistent");
    });

    it("should include parsed author object", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/Example", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const data = await res.json() as { result: { author: { name: string } } };
      expect(data.result.author.name).toBe("fossbilling");
    });
  });

  describe("GET /:id/version", () => {
    it("should return plain text version", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/Example/version", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/plain");
      const text = await res.text();
      expect(text).toBe("0.0.5");
    });

    it("should return 500 for unknown extension", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/nonexistent/version", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(500);
    });
  });

  describe("GET /:id/badges/:type", () => {
    it("should return SVG for version badge", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/Example/badges/version", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
      const svg = await res.text();
      expect(svg).toContain("<svg");
      expect(svg).toContain("v0.0.5");
    });

    it("should return SVG for license badge", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/Example/badges/license", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const svg = await res.text();
      expect(svg).toContain("Apache 2.0");
    });

    it("should return red SVG for unknown badge type", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/Example/badges/unknown_type", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    });

    it("should accept custom color param", async () => {
      const ctx = createExecutionContext();
      const res = await app.request(
        "/extensions/v1/Example/badges/version?color=green",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const svg = await res.text();
      expect(svg).toContain("<svg");
    });

    it("should return 500 for unknown extension", async () => {
      const ctx = createExecutionContext();
      const res = await app.request(
        "/extensions/v1/nonexistent/badges/version",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(500);
    });
  });
});
