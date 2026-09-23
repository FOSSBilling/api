import { describe, it, expect, vi } from "vitest";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  get,
  put,
  sampleDeveloper,
  seedDeveloper
} from "./harness";
import { insertUser } from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call.
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

// Contract invariants: static routes beat param routes, reserved ids stay
// unreachable as data, scope misuse 422s instead of silently returning the
// wrong projection, and every list answers the cursor envelope.
describe("Extensions API v2 contract", () => {
  it("serves static developer routes ahead of /developers/{id}", async () => {
    await put(
      "/extensions/v2/developers/me",
      await authHeaders("user-1"),
      sampleDeveloper()
    );

    const me = await get(
      "/extensions/v2/developers/me",
      await authHeaders("user-1")
    );
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      result: { id: "dev-developer" }
    });
  });

  it("rejects reserved developer ids", async () => {
    for (const reserved of ["me", "claims", "unapproved"]) {
      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders(`user-${reserved}`),
        sampleDeveloper({ id: reserved })
      );
      expect(res.status).toBe(422);
    }
  });

  it("rejects scope misuse instead of returning the wrong projection", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    const mod = await authHeaders("mod-1");

    // developer_id is public-scope only.
    const scoped = await get(
      "/extensions/v2/extensions?scope=mine&developer_id=dev-developer",
      mod
    );
    expect(scoped.status).toBe(422);

    // status/q are all-scope only.
    const queued = await get("/extensions/v2/extensions?status=published", mod);
    expect(queued.status).toBe(422);
  });

  it("answers every list with the cursor envelope", async () => {
    await seedDeveloper("new-developer", "user-1");
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    const mod = await authHeaders("mod-1");

    for (const path of [
      "/extensions/v2/extensions",
      "/extensions/v2/revisions",
      "/extensions/v2/developers",
      "/extensions/v2/developers/claims?scope=pending",
      "/extensions/v2/developers/new-developer/history"
    ]) {
      const res = await get(path, mod);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        pagination: { next_cursor: null, has_more: false }
      });
    }
  });

  it("rejects invalid cursors on every list", async () => {
    await seedDeveloper("new-developer", "user-1");
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    const mod = await authHeaders("mod-1");

    for (const path of [
      "/extensions/v2/extensions?cursor=nope",
      "/extensions/v2/revisions?cursor=nope",
      "/extensions/v2/developers?cursor=nope",
      "/extensions/v2/developers/claims?scope=pending&cursor=nope",
      "/extensions/v2/developers/new-developer/history?cursor=nope"
    ]) {
      const res = await get(path, mod);
      expect(res.status).toBe(422);
    }
  });
});
