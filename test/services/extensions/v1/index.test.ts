import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../../../src/app";
import { getExtensionsDb } from "../../../../src/lib/db";
import {
  developers,
  extensions
} from "../../../../src/services/extensions/v2/db/schema";
import { applyTestMigrations } from "../../../utils/apply-migrations";

const testExtensionRows = [
  {
    id: "Example",
    type: "mod" as const,
    developerId: "fossbilling",
    name: "Example Module",
    description: "An example module for developers.",
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
    license: JSON.stringify({
      name: "Apache 2.0",
      URL: "https://www.apache.org/licenses/LICENSE-2.0"
    }),
    iconUrl:
      "https://raw.githubusercontent.com/FOSSBilling/example-module/main/src/icon.svg",
    readme: "# Example module\n\nThis is an example module.",
    source: JSON.stringify({
      type: "github",
      repo: "FOSSBilling/example-module"
    }),
    version: "0.0.5",
    downloadUrl:
      "https://github.com/FOSSBilling/example-module/releases/download/0.0.5/Example.zip"
  },
  {
    id: "TestTheme",
    type: "theme" as const,
    developerId: "fossbilling",
    name: "Test Theme",
    description: "A test theme.",
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
    downloadUrl: "https://example.com/TestTheme.zip"
  }
];

describe("Extensions API v1", () => {
  beforeAll(applyTestMigrations);

  beforeEach(async () => {
    const db = getExtensionsDb(env.DB_EXTENSIONS);
    await db.delete(extensions);
    await db.delete(developers);

    await db.insert(developers).values({
      id: "fossbilling",
      type: "organization",
      name: "fossbilling",
      url: "https://fossbilling.org"
    });
    // publishedAt is what v1 filters on since migration 0021 - an extension
    // row can now exist before a moderator has approved anything.
    await db.insert(extensions).values(
      testExtensionRows.map((row) => ({
        ...row,
        publishedAt: "2026-01-01T00:00:00.000Z"
      }))
    );
  });

  describe("GET /list", () => {
    it("should return all extensions", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/list", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: unknown[] };
      expect(Array.isArray(data.result)).toBe(true);
      expect(data.result.length).toBe(2);
    });

    it("should filter by type", async () => {
      const ctx = createExecutionContext();
      const res = await app.request(
        "/extensions/v1/list?type=mod",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: Array<{ type: string }> };
      expect(data.result.every((e) => e.type === "mod")).toBe(true);
      expect(data.result.length).toBe(1);
    });

    it("should redirect trailing slash", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/list/", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(301);
    });

    // v1 and v2 share the extensions table and must agree on what counts as
    // published - a moderator delisting an extension in v2 must also pull it
    // from here, or FOSSBilling installs would keep seeing it.
    it("should exclude a delisted extension", async () => {
      const db = getExtensionsDb(env.DB_EXTENSIONS);
      await db
        .update(extensions)
        .set({ delistedAt: "2026-01-01T00:00:00.000Z" })
        .where(eq(extensions.id, "Example"));

      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/list", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const data = (await res.json()) as { result: Array<{ id: string }> };
      expect(data.result.map((e) => e.id)).toEqual(["TestTheme"]);
    });

    it("should parse releases in descending order", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/list", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const data = (await res.json()) as {
        result: Array<{ id: string; releases: Array<{ tag: string }> }>;
      };
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
      const data = (await res.json()) as {
        result: { id: string; name: string };
      };
      expect(data.result.id).toBe("Example");
      expect(data.result.name).toBe("Example Module");
    });

    it("should do case-insensitive lookup", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/example", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: { id: string } };
      expect(data.result.id).toBe("Example");
    });

    it("should return 404 for unknown extension", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/nonexistent", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: { message: string } };
      expect(data.error.message).toContain("nonexistent");
    });

    it("should return 404 for a delisted extension", async () => {
      const db = getExtensionsDb(env.DB_EXTENSIONS);
      await db
        .update(extensions)
        .set({ delistedAt: "2026-01-01T00:00:00.000Z" })
        .where(eq(extensions.id, "Example"));

      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/Example", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(404);
    });

    it("should include parsed author object", async () => {
      const ctx = createExecutionContext();
      const res = await app.request("/extensions/v1/Example", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const data = (await res.json()) as {
        result: { author: { name: string } };
      };
      expect(data.result.author.name).toBe("fossbilling");
    });
  });

  describe("GET /:id/version", () => {
    it("should return plain text version", async () => {
      const ctx = createExecutionContext();
      const res = await app.request(
        "/extensions/v1/Example/version",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/plain");
      const text = await res.text();
      expect(text).toBe("0.0.5");
    });

    it("should return 404 for unknown extension", async () => {
      const ctx = createExecutionContext();
      const res = await app.request(
        "/extensions/v1/nonexistent/version",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(404);
    });
  });

  describe("GET /:id/badges/:type", () => {
    it("should return SVG for version badge", async () => {
      const ctx = createExecutionContext();
      const res = await app.request(
        "/extensions/v1/Example/badges/version",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
      const svg = await res.text();
      expect(svg).toContain("<svg");
      expect(svg).toContain("v0.0.5");
    });

    it("should return SVG for license badge", async () => {
      const ctx = createExecutionContext();
      const res = await app.request(
        "/extensions/v1/Example/badges/license",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const svg = await res.text();
      expect(svg).toContain("Apache 2.0");
    });

    it("should return red SVG for unknown badge type", async () => {
      const ctx = createExecutionContext();
      const res = await app.request(
        "/extensions/v1/Example/badges/unknown_type",
        {},
        env,
        ctx
      );
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

    it("should return 404 for unknown extension", async () => {
      const ctx = createExecutionContext();
      const res = await app.request(
        "/extensions/v1/nonexistent/badges/version",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(404);
    });
  });
});
