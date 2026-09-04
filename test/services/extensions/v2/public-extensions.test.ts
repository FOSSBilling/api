import { describe, it, expect, vi } from "vitest";
import { setupExtensionsV2Tests, db, get, seedOwnedExtension } from "./harness";
import { insertDeveloper, insertExtension } from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

describe("Extensions API v2", () => {
  describe("GET /extensions", () => {
    async function seedCatalogue(ids: string[]): Promise<void> {
      await insertDeveloper(db, {
        id: "catalogue-developer",
        type: "user",
        name: "Catalogue Developer",
        url: null,
        owner_user_id: null
      });
      for (const id of ids) {
        await insertExtension(db, {
          id,
          type: "mod",
          developer_id: "catalogue-developer",
          name: id,
          description: `Description for ${id}`,
          releases: '[{"tag":"1.0.0"}]',
          website: "https://example.com",
          license: '{"name":"MIT"}',
          icon_url: null,
          readme: `README for ${id}`,
          source: '{"type":"github","repo":"example/catalogue"}',
          version: "1.0.0",
          download_url: "https://example.com/download.zip"
        });
      }
    }

    it("lists published extensions with the developer embedded", async () => {
      await seedOwnedExtension();

      const res = await get("/extensions/v2/extensions", {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: Array<{
          id: string;
          developer: { id: string; unclaimed: boolean };
        }>;
      };
      expect(body.result).toHaveLength(1);
      expect(body.result[0].id).toBe("existing-ext");
      expect(body.result[0].developer.id).toBe("owner-developer");
      expect(body.result[0].developer.unclaimed).toBe(false);
      expect(body.result[0]).not.toHaveProperty("readme");
      expect(body.result[0]).not.toHaveProperty("releases");
    });

    it("marks unowned public developers as unclaimed", async () => {
      await seedCatalogue(["legacy-extension"]);

      const res = await get("/extensions/v2/extensions", {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: Array<{ developer: { unclaimed: boolean } }>;
      };
      expect(body.result[0].developer.unclaimed).toBe(true);
    });

    it("filters by type", async () => {
      await seedOwnedExtension();

      const matching = await get("/extensions/v2/extensions?type=mod", {});
      const matchingBody = (await matching.json()) as { result: unknown[] };
      expect(matchingBody.result).toHaveLength(1);

      const nonMatching = await get("/extensions/v2/extensions?type=theme", {});
      const nonMatchingBody = (await nonMatching.json()) as {
        result: unknown[];
      };
      expect(nonMatchingBody.result).toHaveLength(0);
    });

    it("422s on an invalid type filter", async () => {
      const res = await get("/extensions/v2/extensions?type=not-a-type", {});
      expect(res.status).toBe(422);
    });

    it("filters by developer_id", async () => {
      await seedOwnedExtension();

      const matching = await get(
        "/extensions/v2/extensions?developer_id=owner-developer",
        {}
      );
      const matchingBody = (await matching.json()) as { result: unknown[] };
      expect(matchingBody.result).toHaveLength(1);

      const nonMatching = await get(
        "/extensions/v2/extensions?developer_id=someone-else",
        {}
      );
      const nonMatchingBody = (await nonMatching.json()) as {
        result: unknown[];
      };
      expect(nonMatchingBody.result).toHaveLength(0);
    });

    it("returns deterministic first, middle, and final pages", async () => {
      await seedCatalogue(["charlie", "Alpha", "bravo", "delta", "echo"]);

      const first = await get("/extensions/v2/extensions?limit=2", {});
      const firstBody = (await first.json()) as {
        result: Array<{ id: string }>;
        pagination: { next_cursor: string | null; has_more: boolean };
      };
      expect(firstBody.result.map(({ id }) => id)).toEqual(["Alpha", "bravo"]);
      expect(firstBody.pagination.has_more).toBe(true);

      const middle = await get(
        `/extensions/v2/extensions?limit=2&cursor=${encodeURIComponent(firstBody.pagination.next_cursor!)}`,
        {}
      );
      const middleBody = (await middle.json()) as typeof firstBody;
      expect(middleBody.result.map(({ id }) => id)).toEqual([
        "charlie",
        "delta"
      ]);
      expect(middleBody.pagination.has_more).toBe(true);

      const final = await get(
        `/extensions/v2/extensions?limit=2&cursor=${encodeURIComponent(middleBody.pagination.next_cursor!)}`,
        {}
      );
      const finalBody = (await final.json()) as typeof firstBody;
      expect(finalBody.result.map(({ id }) => id)).toEqual(["echo"]);
      expect(finalBody.pagination).toEqual({
        next_cursor: null,
        has_more: false
      });
    });

    it("rejects invalid cursors", async () => {
      const res = await get(
        "/extensions/v2/extensions?cursor=not-a-cursor",
        {}
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        error: { code: "INVALID_CURSOR" }
      });

      const blank = await get("/extensions/v2/extensions?cursor=", {});
      expect(blank.status).toBe(422);
    });

    it("supports UTF-8 extension ids in cursors", async () => {
      await seedCatalogue(["alpha", "zulu", "éclair", "😀"]);

      const first = await get("/extensions/v2/extensions?limit=3", {});
      const firstBody = (await first.json()) as {
        pagination: { next_cursor: string | null };
      };
      expect(first.status).toBe(200);
      expect(firstBody.pagination.next_cursor).not.toBeNull();

      const second = await get(
        `/extensions/v2/extensions?limit=3&cursor=${encodeURIComponent(firstBody.pagination.next_cursor!)}`,
        {}
      );
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({
        result: [{ id: "😀" }],
        pagination: { next_cursor: null, has_more: false }
      });
    });

    it("accepts the maximum limit and rejects values above it", async () => {
      await seedCatalogue(["one"]);
      expect(
        (await get("/extensions/v2/extensions?limit=100", {})).status
      ).toBe(200);
      expect(
        (await get("/extensions/v2/extensions?limit=101", {})).status
      ).toBe(422);
    });
  });

  describe("GET /extensions/{id}", () => {
    it("gets a single extension, case-insensitively", async () => {
      await seedOwnedExtension();

      const res = await get("/extensions/v2/extensions/EXISTING-EXT", {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: {
          id: string;
          developer: { name: string; approved: boolean; unclaimed: boolean };
        };
      };
      expect(body.result.id).toBe("existing-ext");
      expect(body.result.developer.name).toBe("Owner");
      expect(body.result.developer.approved).toBe(false);
      expect(body.result.developer.unclaimed).toBe(false);
      expect(body.result).toMatchObject({
        readme: "r",
        releases: [],
        source: { type: "github", repo: "example/existing" },
        version: "1.0.0",
        download_url: "https://e.com/d.zip"
      });
    });

    it("404s for an unknown extension", async () => {
      const res = await get("/extensions/v2/extensions/no-such-extension", {});
      expect(res.status).toBe(404);
    });

    it("404s for a delisted extension, even though it is still published", async () => {
      await insertDeveloper(db, {
        id: "catalogue-developer",
        type: "user",
        name: "Catalogue Developer",
        url: null,
        owner_user_id: null
      });
      await insertExtension(db, {
        id: "delisted-ext",
        developer_id: "catalogue-developer",
        delisted_at: "2026-01-01T00:00:00.000Z",
        delist_reason: "Upstream source removed"
      });

      expect(
        (await get("/extensions/v2/extensions/delisted-ext", {})).status
      ).toBe(404);

      const list = await get("/extensions/v2/extensions", {});
      await expect(list.json()).resolves.toMatchObject({ result: [] });
    });
  });
});
