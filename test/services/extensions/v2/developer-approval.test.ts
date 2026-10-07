import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { DeveloperProfileSchema } from "../../../../src/services/extensions/v2/schemas/developers";
import { wrapD1WithHook } from "./db-interceptor";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  put,
  get,
  post,
  del,
  sampleDeveloper
} from "./harness";
import {
  getDeveloper,
  insertDeveloper,
  insertExtension,
  insertUser
} from "./db-fixtures";

vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

const profilePath = "/extensions/v2/developers/dev-developer";

async function review(headers: Record<string, string>) {
  const response = await get(profilePath, headers);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: unknown };
  const profile = DeveloperProfileSchema.parse(body.result);
  return {
    expected_revision: profile.content_revision,
    expected_generation: profile.profile_generation
  };
}

async function setupReview() {
  const owner = await authHeaders("owner");
  await insertUser(db, { id: "moderator", is_moderator: 1 });
  const moderator = await authHeaders("moderator");
  expect(
    (await put("/extensions/v2/developers/me", owner, sampleDeveloper())).status
  ).toBe(200);
  return { owner, moderator, reviewed: await review(moderator) };
}

describe("Developer approval binds to the reviewed profile instance and content", () => {
  it.each([
    ["profile deletion, same owner", "/extensions/v2/developers/me", "owner"],
    [
      "profile deletion, different owner",
      "/extensions/v2/developers/me",
      "replacement-owner"
    ],
    ["account deletion", "/extensions/v2/users/me", "replacement-owner"]
  ])(
    "rejects stale approval after %s",
    async (_label, deletionPath, replacementOwner) => {
      const { owner, moderator, reviewed } = await setupReview();
      expect((await del(deletionPath, owner)).status).toBe(200);
      expect(
        (
          await put(
            "/extensions/v2/developers/me",
            await authHeaders(replacementOwner),
            sampleDeveloper({ name: "Unreviewed replacement" })
          )
        ).status
      ).toBe(200);
      const replacement = await review(moderator);
      expect(replacement.expected_revision).toBe(reviewed.expected_revision);
      expect(replacement.expected_generation).not.toBe(
        reviewed.expected_generation
      );
      const stale = await post(`${profilePath}/approve`, moderator, reviewed);
      expect(stale.status).toBe(409);
      expect(await getDeveloper(db, "dev-developer")).toMatchObject({
        approved_at: null,
        approved_revision: null,
        approved_by: null
      });
      const publicBody = (await (await get(profilePath, {})).json()) as {
        result: Record<string, unknown>;
      };
      expect(publicBody.result).toMatchObject({
        name: "Unreviewed replacement",
        approved: false
      });
      expect(publicBody.result).not.toHaveProperty("profile_generation");
      expect(publicBody.result).not.toHaveProperty("content_revision");
      expect(
        (await post(`${profilePath}/approve`, moderator, replacement)).status
      ).toBe(200);
      expect(await getDeveloper(db, "dev-developer")).toMatchObject({
        approved_revision: 1,
        approved_by: "moderator"
      });
    }
  );

  it("checks the instance atomically when recreation wins immediately before approval", async () => {
    const { owner, moderator, reviewed } = await setupReview();
    let recreated = false;
    env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
      if (
        !recreated &&
        /^\s*update/i.test(sql) &&
        sql.includes("approved_at")
      ) {
        recreated = true;
        env.DB_EXTENSIONS = db;
        expect((await del("/extensions/v2/developers/me", owner)).status).toBe(
          200
        );
        expect(
          (
            await put(
              "/extensions/v2/developers/me",
              owner,
              sampleDeveloper({ name: "Raced replacement" })
            )
          ).status
        ).toBe(200);
      }
    });
    expect(
      (await post(`${profilePath}/approve`, moderator, reviewed)).status
    ).toBe(409);
    expect(recreated).toBe(true);
    expect((await getDeveloper(db, "dev-developer"))?.approved_at).toBeNull();
  });

  it("does not apply an owner edit read from a deleted profile to its replacement", async () => {
    const { owner, reviewed } = await setupReview();
    let recreated = false;
    env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
      if (
        !recreated &&
        /^\s*update/i.test(sql) &&
        sql.includes("content_revision")
      ) {
        recreated = true;
        env.DB_EXTENSIONS = db;
        expect((await del("/extensions/v2/developers/me", owner)).status).toBe(
          200
        );
        expect(
          (
            await put(
              "/extensions/v2/developers/me",
              owner,
              sampleDeveloper({ name: "Replacement" })
            )
          ).status
        ).toBe(200);
      }
    });
    const edit = await put(
      "/extensions/v2/developers/me",
      owner,
      sampleDeveloper({ name: "Paused old edit" })
    );
    expect(edit.status).toBe(409);
    expect(recreated).toBe(true);
    const replacement = await getDeveloper(db, "dev-developer");
    expect(replacement).toMatchObject({
      name: "Replacement",
      content_revision: 1,
      approved_at: null
    });
    expect(replacement?.profile_generation).not.toBe(
      reviewed.expected_generation
    );
  });

  it("rejects missing, malformed, and wrong generation tokens", async () => {
    const { moderator, reviewed } = await setupReview();
    for (const token of [undefined, "", "ABCDEF".repeat(5), 123, null]) {
      expect(
        (
          await post(`${profilePath}/approve`, moderator, {
            expected_revision: 1,
            expected_generation: token
          })
        ).status
      ).toBe(422);
    }
    expect(
      (
        await post(`${profilePath}/approve`, moderator, {
          ...reviewed,
          expected_generation: "0".repeat(32)
        })
      ).status
    ).toBe(409);
    expect((await getDeveloper(db, "dev-developer"))?.approved_at).toBeNull();
  });

  it("rejects reviewed content after two edits with identical timestamps", async () => {
    const { owner, moderator, reviewed } = await setupReview();
    for (const name of ["Second version", "Third version"]) {
      expect(
        (
          await put(
            "/extensions/v2/developers/me",
            owner,
            sampleDeveloper({ name })
          )
        ).status
      ).toBe(200);
      // Model second-granular timestamps deterministically without timing a test.
      await db
        .prepare("UPDATE developers SET updated_at = ? WHERE id = ?")
        .bind("2026-10-07 00:00:00", "dev-developer")
        .run();
    }
    expect(await getDeveloper(db, "dev-developer")).toMatchObject({
      content_revision: 3,
      profile_generation: reviewed.expected_generation,
      updated_at: "2026-10-07 00:00:00"
    });
    expect(
      (await post(`${profilePath}/approve`, moderator, reviewed)).status
    ).toBe(409);
    expect(
      (
        await post(`${profilePath}/approve`, moderator, {
          ...reviewed,
          expected_revision: 2
        })
      ).status
    ).toBe(409);
    expect(
      (await post(`${profilePath}/approve`, moderator, await review(moderator)))
        .status
    ).toBe(200);
  });

  it.each([null, 1, 2])(
    "projects approved_revision=%s consistently across public reads and the review queue",
    async (approvedRevision) => {
      await insertUser(db, { id: "moderator", is_moderator: 1 });
      const moderator = await authHeaders("moderator");
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "user",
        name: "Developer",
        approved_at: "2026-10-07 00:00:00",
        content_revision: 2,
        approved_revision: approvedRevision
      });
      await insertExtension(db, {
        id: "live-ext",
        developer_id: "dev-developer"
      });
      const expected = approvedRevision === 2;
      const profile = (await (await get(profilePath, {})).json()) as {
        result: { approved: boolean };
      };
      const detail = (await (
        await get("/extensions/v2/extensions/live-ext", {})
      ).json()) as { result: { developer: { approved: boolean } } };
      const list = (await (
        await get("/extensions/v2/extensions", {})
      ).json()) as { result: Array<{ developer: { approved: boolean } }> };
      expect(profile.result.approved).toBe(expected);
      expect(detail.result.developer.approved).toBe(expected);
      expect(list.result[0].developer.approved).toBe(expected);
      for (const query of ["scope", "status"]) {
        const queue = (await (
          await get(`/extensions/v2/developers?${query}=unapproved`, moderator)
        ).json()) as { result: Array<{ id: string }> };
        expect(queue.result.some((item) => item.id === "dev-developer")).toBe(
          !expected
        );
      }
    }
  );
});
