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
    id: "badge-dev",
    type: "user",
    name: "Developer"
  });
  await insertExtension(db, {
    id: "example",
    developer_id: "badge-dev",
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

  it.each(["missing", "unpublished", "delisted"])(
    "hides %s extensions",
    async (kind) => {
      if (kind === "missing")
        await db.prepare("DELETE FROM extensions WHERE id='example'").run();
      if (kind === "unpublished")
        await db
          .prepare("UPDATE extensions SET published_at=NULL WHERE id='example'")
          .run();
      if (kind === "delisted")
        await db
          .prepare(
            "UPDATE extensions SET delisted_at=CURRENT_TIMESTAMP, delist_reason='Removed' WHERE id='example'"
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
      .prepare("UPDATE extensions SET releases='[]' WHERE id='example'")
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
      .prepare("UPDATE extensions SET releases=? WHERE id='example'")
      .bind(
        JSON.stringify([release("1.0.0", '</text><script>alert("x")</script>')])
      )
      .run();
    const svg = await (await badge("fossbilling")).text();
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
  });

  it("does not read large unrelated content fields", async () => {
    await db
      .prepare("UPDATE extensions SET readme=? WHERE id='example'")
      .bind("x".repeat(300_000))
      .run();
    const queries: string[] = [];
    env.DB_EXTENSIONS = wrapD1WithHook(db, (sql) => {
      queries.push(sql);
      if (/\breadme\b/i.test(sql))
        throw new Error("Badges must not select README content");
    });
    expect((await badge("fossbilling")).status).toBe(200);
    expect(queries.some((sql) => /from "extensions"/i.test(sql))).toBe(true);
  });

  it("refuses oversized stored badge fields without truncation", async () => {
    await db
      .prepare("UPDATE extensions SET license=? WHERE id='example'")
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
    ).json()) as {
      paths: Record<
        string,
        {
          get: {
            responses: Record<string, { content?: Record<string, unknown> }>;
          };
        }
      >;
    };
    const route = document.paths["/extensions/{id}/badges/{type}"].get;
    expect(route.responses["200"].content).toHaveProperty("image/svg+xml");
    expect(route.responses).toHaveProperty("404");
    expect(route.responses).toHaveProperty("422");
  });

  it("keeps v1 badge paths, labels, minimums, colors, and unknown-type behavior", async () => {
    await db
      .prepare("UPDATE extensions SET releases=?, license=? WHERE id='example'")
      .bind(JSON.stringify([release("1.0.0", ">=0.8.9 <1.0")]), '"MIT"')
      .run();
    const minimum = await get(
      "/extensions/v1/example/badges/min_fossbilling_version",
      {}
    );
    expect(minimum.status).toBe(200);
    expect(await minimum.text()).toContain(
      "Minimum FOSSBilling version: v0.8.9"
    );
    const version = await get(
      "/extensions/v1/example/badges/version?color=green",
      {}
    );
    expect(version.status).toBe(200);
    const svg = await version.text();
    expect(svg).toContain("Latest version: v1.0.0");
    expect(svg).toContain('fill="#67ac09"');
    expect(
      await (await get("/extensions/v1/example/badges/license", {})).text()
    ).toContain("License: MIT");
    expect(
      (await get("/extensions/v1/example/badges/unknown", {})).status
    ).toBe(200);
  });
});
