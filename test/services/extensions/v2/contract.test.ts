import { describe, it, expect, vi } from "vitest";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  get,
  post,
  put,
  sampleDeveloper,
  seedDeveloper,
  seedUnownedDeveloper
} from "./harness";
import { insertDeveloper, insertUser } from "./db-fixtures";

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

  it("walks past the first page when rows exceed the limit", async () => {
    await insertDeveloper(db, {
      id: "aaa-developer",
      type: "user",
      name: "Aaa Developer",
      url: null,
      owner_user_id: "user-1"
    });
    await insertDeveloper(db, {
      id: "zzz-developer",
      type: "user",
      name: "Zzz Developer",
      url: null,
      owner_user_id: "user-2"
    });
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    const mod = await authHeaders("mod-1");

    const first = await get("/extensions/v2/developers?limit=1", mod);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      result: Array<{ id: string }>;
      pagination: { next_cursor: string | null; has_more: boolean };
    };
    expect(firstBody.result.map((d) => d.id)).toEqual(["aaa-developer"]);
    expect(firstBody.pagination.has_more).toBe(true);
    expect(firstBody.pagination.next_cursor).toBeTruthy();

    const second = await get(
      `/extensions/v2/developers?limit=1&cursor=${encodeURIComponent(firstBody.pagination.next_cursor as string)}`,
      mod
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      result: Array<{ id: string }>;
      pagination: { next_cursor: string | null; has_more: boolean };
    };
    expect(secondBody.result.map((d) => d.id)).toEqual(["zzz-developer"]);
    expect(secondBody.pagination).toEqual({
      next_cursor: null,
      has_more: false
    });
  });

  it("rejects a legacy offset parameter instead of ignoring it", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    const mod = await authHeaders("mod-1");

    for (const path of [
      "/extensions/v2/developers?limit=10&offset=10",
      "/extensions/v2/developers/claims?scope=pending&limit=10&offset=10"
    ]) {
      const res = await get(path, mod);
      expect(res.status).toBe(422);
    }
  });

  it("rejects a claims cursor reused across scopes", async () => {
    await seedUnownedDeveloper("legacy-a");
    await seedUnownedDeveloper("legacy-b");
    await post(
      "/extensions/v2/developers/legacy-a/claim",
      await authHeaders("user-1"),
      {}
    );
    await post(
      "/extensions/v2/developers/legacy-b/claim",
      await authHeaders("user-1"),
      {}
    );
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    const mod = await authHeaders("mod-1");

    const mine = await get(
      "/extensions/v2/developers/claims?scope=mine&limit=1",
      await authHeaders("user-1")
    );
    const mineBody = (await mine.json()) as {
      pagination: { next_cursor: string | null; has_more: boolean };
    };
    expect(mineBody.pagination.has_more).toBe(true);

    const crossed = await get(
      `/extensions/v2/developers/claims?scope=pending&cursor=${encodeURIComponent(mineBody.pagination.next_cursor as string)}`,
      mod
    );
    expect(crossed.status).toBe(422);
  });

  it("rejects a history cursor from another developer", async () => {
    await put(
      "/extensions/v2/developers/me",
      await authHeaders("user-1"),
      sampleDeveloper({ id: "dev-a", name: "Dev A" })
    );
    await put(
      "/extensions/v2/developers/me",
      await authHeaders("user-1"),
      sampleDeveloper({ id: "dev-a", name: "Dev A Edited" })
    );
    await put(
      "/extensions/v2/developers/me",
      await authHeaders("user-2"),
      sampleDeveloper({ id: "dev-b", name: "Dev B" })
    );
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    const mod = await authHeaders("mod-1");

    const first = await get(
      "/extensions/v2/developers/dev-a/history?limit=1",
      mod
    );
    const firstBody = (await first.json()) as {
      pagination: { next_cursor: string | null; has_more: boolean };
    };
    expect(firstBody.pagination.has_more).toBe(true);

    const crossed = await get(
      `/extensions/v2/developers/dev-b/history?cursor=${encodeURIComponent(firstBody.pagination.next_cursor as string)}`,
      mod
    );
    expect(crossed.status).toBe(422);
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
