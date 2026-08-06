import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  setupExtensionsV2Tests,
  authHeaders,
  post,
  get,
  samplePayload,
  seedDeveloper,
  seedOwnedExtension
} from "./harness";
import {
  countSubmissions,
  getSubmission,
  listSubmissions
} from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", () => {
  const endpoint = { DEFAULTS: {} };
  const derivedFn = Object.assign(vi.fn(), { defaults: vi.fn(), endpoint });
  const request = Object.assign(vi.fn(), {
    defaults: vi.fn().mockReturnValue(derivedFn),
    endpoint
  });
  return { request };
});

let db: D1Database;

setupExtensionsV2Tests();

beforeEach(() => {
  db = env.DB_EXTENSIONS;
});

describe("Extensions API v2", () => {
  describe("POST /submissions", () => {
    it("requires auth", async () => {
      const res = await post(
        "/extensions/v2/submissions",
        {
          "Content-Type": "application/json"
        },
        samplePayload()
      );
      expect(res.status).toBe(401);
    });

    it("rejects an invalid payload", async () => {
      const headers = await authHeaders("user-1");
      const res = await post("/extensions/v2/submissions", headers, {
        developer: {},
        extension: {}
      });
      expect(res.status).toBe(422);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects the reserved extension id mine", async () => {
      const payload = samplePayload({ extensionId: "mine" });
      const res = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        payload
      );

      expect(res.status).toBe(422);
      expect(await countSubmissions(db)).toBe(0);
    });

    it("rejects profile fields (avatar_url/contact_email) on a submission's developer", async () => {
      await seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      const payload = samplePayload();
      const res = await post("/extensions/v2/submissions", headers, {
        ...payload,
        developer: {
          ...payload.developer,
          avatar_url: "https://example.com/should-not-be-accepted.png"
        }
      });

      expect(res.status).toBe(422);
      expect(await countSubmissions(db)).toBe(0);
    });

    it("creates a pending submission for a brand-new extension under an existing developer", async () => {
      await seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload()
      );

      expect(res.status).toBe(201);
      const data = (await res.json()) as {
        result: { id: string; status: string };
      };
      expect(data.result.status).toBe("pending");
      expect(await countSubmissions(db)).toBe(1);

      const stored = await getSubmission(db, data.result.id);
      expect(stored?.extension_id).toBeNull();
      expect(stored?.submitted_by).toBe("user-1");
    });

    it("rejects editing an extension not owned by the caller", async () => {
      await seedOwnedExtension();
      const headers = await authHeaders("intruder");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({
          extensionId: "existing-ext",
          developerId: "owner-developer"
        })
      );

      expect(res.status).toBe(403);
      expect(await countSubmissions(db)).toBe(0);
    });

    it("allows editing an extension owned by the caller", async () => {
      await seedOwnedExtension();
      const headers = await authHeaders("owner-1");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({
          extensionId: "existing-ext",
          developerId: "owner-developer"
        })
      );

      expect(res.status).toBe(201);
      const [stored] = await listSubmissions(db);
      expect(stored.extension_id).toBe("existing-ext");
    });

    it("rejects claiming a developer already owned by someone else", async () => {
      await seedOwnedExtension();
      const headers = await authHeaders("intruder");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({
          extensionId: "another-new-ext",
          developerId: "owner-developer"
        })
      );

      expect(res.status).toBe(403);
    });

    it("rejects naming a developer id that doesn't exist at all", async () => {
      const headers = await authHeaders("user-1");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({ developerId: "no-such-developer" })
      );

      expect(res.status).toBe(403);
      expect(await countSubmissions(db)).toBe(0);
    });

    it("bounds payload size and the number of releases", async () => {
      await seedDeveloper("new-developer", "user-1");
      const payload = samplePayload();
      const oversized = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        {
          ...payload,
          extension: { ...payload.extension, readme: "x".repeat(100_001) }
        }
      );
      expect(oversized.status).toBe(422);

      const unknownExtensionField = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        {
          ...payload,
          extension: {
            ...payload.extension,
            padding: "x"
          }
        }
      );
      expect(unknownExtensionField.status).toBe(422);
      const unknownExtensionBody = (await unknownExtensionField.json()) as {
        error: { details: Array<{ code: string; path: PropertyKey[] }> };
      };
      expect(unknownExtensionBody.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unrecognized_keys",
            path: ["extension"]
          })
        ])
      );

      const unknownReleaseField = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        {
          ...payload,
          extension: {
            ...payload.extension,
            releases: [
              {
                ...payload.extension.releases[0],
                padding: "x"
              }
            ]
          }
        }
      );
      expect(unknownReleaseField.status).toBe(422);
      const unknownReleaseBody = (await unknownReleaseField.json()) as {
        error: { details: Array<{ code: string; path: PropertyKey[] }> };
      };
      expect(unknownReleaseBody.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unrecognized_keys",
            path: ["extension", "releases", 0]
          })
        ])
      );

      const tooManyReleases = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        {
          ...payload,
          extension: {
            ...payload.extension,
            releases: Array.from(
              { length: 101 },
              () => payload.extension.releases[0]
            )
          }
        }
      );
      expect(tooManyReleases.status).toBe(422);
    });

    it("preserves compatibility with stored slug ids over 100 characters", async () => {
      const developerId = "d".repeat(120);
      const extensionId = "e".repeat(120);
      await seedDeveloper(developerId, "user-1");

      const res = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload({ developerId, extensionId })
      );

      expect(res.status).toBe(201);
    });

    it("rejects duplicate pending targets and caps each user's backlog", async () => {
      await seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      expect(
        (await post("/extensions/v2/submissions", headers, samplePayload()))
          .status
      ).toBe(201);
      expect(
        (await post("/extensions/v2/submissions", headers, samplePayload()))
          .status
      ).toBe(409);

      await seedDeveloper("other-developer", "user-2");
      expect(
        (
          await post(
            "/extensions/v2/submissions",
            await authHeaders("user-2"),
            samplePayload({ developerId: "other-developer" })
          )
        ).status
      ).toBe(409);

      for (let index = 1; index < 10; index++) {
        const result = await post(
          "/extensions/v2/submissions",
          headers,
          samplePayload({ extensionId: `new-ext-${index}` })
        );
        expect(result.status).toBe(201);
      }
      const overLimit = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({ extensionId: "new-ext-over-limit" })
      );
      expect(overLimit.status).toBe(409);
      expect(await countSubmissions(db)).toBe(10);
    });
  });

  describe("GET /submissions/mine", () => {
    it("returns only the caller's own submissions", async () => {
      await seedDeveloper("developer-a", "user-1");
      await seedDeveloper("developer-b", "user-2");
      await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload({ extensionId: "ext-a", developerId: "developer-a" })
      );
      await post(
        "/extensions/v2/submissions",
        await authHeaders("user-2"),
        samplePayload({ extensionId: "ext-b", developerId: "developer-b" })
      );

      const res = await get(
        "/extensions/v2/submissions/mine",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: Array<{ submitted_by: string }>;
      };
      expect(data.result).toHaveLength(1);
      expect(data.result[0].submitted_by).toBe("user-1");
    });

    it("requires auth", async () => {
      const res = await get("/extensions/v2/submissions/mine", {});
      expect(res.status).toBe(401);
    });

    it("identifies invalid cursors", async () => {
      const res = await get(
        "/extensions/v2/submissions/mine?cursor=not-a-cursor",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "INVALID_CURSOR" }
      });
    });

    it("paginates deterministically with an opaque cursor", async () => {
      await seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      for (const extensionId of ["page-a", "page-b", "page-c"]) {
        expect(
          (
            await post(
              "/extensions/v2/submissions",
              headers,
              samplePayload({ extensionId })
            )
          ).status
        ).toBe(201);
      }

      const first = await get(
        "/extensions/v2/submissions/mine?limit=2",
        headers
      );
      const firstBody = (await first.json()) as {
        result: unknown[];
        pagination: { has_more: boolean; next_cursor: string };
      };
      expect(firstBody.result).toHaveLength(2);
      expect(firstBody.pagination.has_more).toBe(true);

      const second = await get(
        `/extensions/v2/submissions/mine?limit=2&cursor=${encodeURIComponent(firstBody.pagination.next_cursor)}`,
        headers
      );
      const secondBody = (await second.json()) as {
        result: unknown[];
        pagination: { has_more: boolean; next_cursor: null };
      };
      expect(secondBody.result).toHaveLength(1);
      expect(secondBody.pagination).toEqual({
        has_more: false,
        next_cursor: null
      });
    });
  });
});
