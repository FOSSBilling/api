import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { db, get, setupExtensionsV2Tests } from "./harness";
import { insertDeveloper, insertExtension } from "./db-fixtures";
import { wrapD1WithHook } from "./db-interceptor";

vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);
setupExtensionsV2Tests();

const requirement = ">=0.8.9 <1.0 || ^2.0 !=2.1.0";
const release = (tag: string, fossbilling: string) => ({
  tag,
  date: "2026-11-05",
  download_url: "https://example.test/release.zip",
  requires: { fossbilling, php: ">=8.3" }
});
const badge = (type: string) =>
  get(`/extensions/v2/extensions/example/badges/${type}`, {});

beforeEach(async () => {
  await insertDeveloper(db, {
    identifier: "badge-dev",
    type: "user",
    name: "Developer"
  });
  await insertExtension(db, {
    identifier: "example",
    developer_identifier: "badge-dev",
    license: '"MIT OR Apache-2.0"',
    // Deliberately unordered; requirements belong to each release, not to the
    // root manifest or to the first element of a stored array.
    releases: JSON.stringify([
      release("1.0.0", "^0.7"),
      release("2.0.0", requirement)
    ]),
    manifest: JSON.stringify({
      manifest_version: 1,
      author: { name: "Author" },
      requires: { fossbilling: "different-current-metadata", php: ">=8.3" }
    })
  });
});

describe("v2 public badges", () => {
  it("displays the complete latest-release requirement, including Composer exclusions", async () => {
    const response = await badge("fossbilling");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, s-maxage=3600"
    );
    const svg = await response.text();
    expect(svg).toContain("FOSSBilling: &gt;=0.8.9 &lt;1.0 || ^2.0 !=2.1.0");
    expect(svg).not.toContain("different-current-metadata");
    expect(svg).not.toContain("v&gt;=");
  });

  it("renders version and license without converting requirements to a minimum", async () => {
    const version = await badge("version");
    const license = await badge("license");
    expect(version.status).toBe(200);
    expect(await version.text()).toContain("Latest version: v2.0.0");
    expect(license.status).toBe(200);
    expect(await license.text()).toContain("License: MIT OR Apache-2.0");
  });

  it("supports case-insensitive extension lookup and color overrides", async () => {
    const response = await get(
      "/extensions/v2/extensions/EXAMPLE/badges/version?color=green",
      {}
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('fill="#67ac09"');
  });

  it.each(["not-a-color", "rgb("])(
    "uses badge-maker's fallback for an unrecognized color %s",
    async (color) => {
      const response = await badge(
        `version?color=${encodeURIComponent(color)}`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("image/svg+xml");
      expect(await response.text()).toContain('fill="#4b0"');
    }
  );

  it.each(["missing", "unpublished", "delisted"])(
    "hides %s extensions",
    async (kind) => {
      if (kind === "missing")
        await db
          .prepare("DELETE FROM extensions WHERE identifier='example'")
          .run();
      if (kind === "unpublished")
        await db
          .prepare(
            "UPDATE extensions SET published_at=NULL WHERE identifier='example'"
          )
          .run();
      if (kind === "delisted")
        await db
          .prepare(
            "UPDATE extensions SET delisted_at=CURRENT_TIMESTAMP, delist_reason='Removed' WHERE identifier='example'"
          )
          .run();
      const response = await badge("fossbilling");
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBeNull();
    }
  );

  it.each([
    "min_fossbilling_version",
    "unknown",
    "version?color=",
    `license?color=${"x".repeat(101)}`
  ])("rejects invalid badge parameters %s", async (type) => {
    expect((await badge(type)).status).toBe(422);
  });

  it("handles empty release histories explicitly", async () => {
    await db
      .prepare("UPDATE extensions SET releases='[]' WHERE identifier='example'")
      .run();
    expect(await (await badge("version")).text()).toContain(
      "Latest version: unknown"
    );
    expect(await (await badge("fossbilling")).text()).toContain(
      "FOSSBilling: unknown"
    );
    expect(await (await badge("license")).text()).toContain(
      "MIT OR Apache-2.0"
    );
  });

  it("escapes requirement text in the generated SVG", async () => {
    await db
      .prepare("UPDATE extensions SET releases=? WHERE identifier='example'")
      .bind(
        JSON.stringify([release("1.0.0", '</text><script>alert("x")</script>')])
      )
      .run();
    const svg = await (await badge("fossbilling")).text();
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
  });

  it("renders badges when README content exceeds detail limits", async () => {
    await db
      .prepare("UPDATE extensions SET readme=? WHERE identifier='example'")
      .bind("x".repeat(300_000))
      .run();
    const queries: string[] = [];
    env.DB_EXTENSIONS = wrapD1WithHook(db, (sql) => {
      queries.push(sql);
    });
    expect((await badge("fossbilling")).status).toBe(200);
    expect(queries.join("\n")).not.toMatch(/\breadme\b/i);
  });

  it("refuses oversized stored badge fields without truncation", async () => {
    await db
      .prepare("UPDATE extensions SET license=? WHERE identifier='example'")
      .bind(JSON.stringify("A".repeat(1001)))
      .run();
    const response = await badge("license");
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("maps database failures to an uncached error", async () => {
    env.DB_EXTENSIONS = wrapD1WithHook(db, () => {
      throw new Error("injected failure");
    });
    const response = await badge("version");
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("publishes the badge contract in OpenAPI", async () => {
    const document = (await (
      await get("/extensions/v2/docs/openapi.json", {})
    ).json()) as { paths: Record<string, unknown> };
    expect(document.paths["/extensions/{id}/badges/{type}"]).toMatchObject({
      get: {
        responses: {
          200: { content: { "image/svg+xml": { schema: { type: "string" } } } },
          404: {},
          422: {}
        }
      }
    });
  });
});
