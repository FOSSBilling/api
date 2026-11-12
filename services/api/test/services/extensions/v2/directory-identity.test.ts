import { UUID_V7 } from "./db-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  authHeaders,
  db,
  get,
  post,
  put,
  sampleCreate,
  sampleDeveloper,
  setupExtensionsV2Tests
} from "./harness";

vi.mock("../../../../src/lib/github-app", () => ({
  githubTokenProvider: () => async () => "test-github-token"
}));

vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);
setupExtensionsV2Tests();

describe("directory identity", () => {
  it("generates UUIDv7 keys and keeps public identifiers out of foreign keys", async () => {
    const headers = await authHeaders("owner");
    const profile = await put(
      "/extensions/v2/developers/me",
      headers,
      sampleDeveloper()
    );
    expect(profile.status).toBe(200);
    const developer = (
      (await profile.json()) as { result: { id: string; identifier: string } }
    ).result;
    expect(developer.id).toMatch(UUID_V7);
    expect(developer.identifier).toBe("dev-developer");
    const created = await post(
      "/extensions/v2/extensions",
      headers,
      sampleCreate()
    );
    expect(created.status).toBe(201);
    const extension = (
      (await created.json()) as {
        result: { id: string; identifier: string; revision_id: string };
      }
    ).result;
    expect(extension.id).toMatch(UUID_V7);
    expect(extension.identifier).toBe("new-ext");
    expect(
      await db
        .prepare("SELECT developer_id FROM extensions WHERE id=?")
        .bind(extension.id)
        .first()
    ).toEqual({ developer_id: developer.id });
    expect(
      await db
        .prepare(
          "SELECT extension_id,developer_id FROM extension_revisions WHERE id=?"
        )
        .bind(extension.revision_id)
        .first()
    ).toEqual({ extension_id: extension.id, developer_id: developer.id });
    expect(
      (await get("/extensions/v2/extensions/new-ext", headers)).status
    ).toBe(200);
    expect(
      (await get(`/extensions/v2/extensions/${extension.id}`, headers)).status
    ).toBe(404);
    expect(
      (await get("/extensions/v2/developers/dev-developer", headers)).status
    ).toBe(200);
  });

  it("preserves both identities when display names change", async () => {
    const headers = await authHeaders("owner");
    const response = await put(
      "/extensions/v2/developers/me",
      headers,
      sampleDeveloper()
    );
    expect(response.status).toBe(200);
    const before = (
      (await response.json()) as { result: { id: string; identifier: string } }
    ).result;
    const updated = await put(
      "/extensions/v2/developers/me",
      headers,
      sampleDeveloper({ name: "New Display Name" })
    );
    expect(updated.status).toBe(200);
    expect(
      ((await updated.json()) as { result: unknown }).result
    ).toMatchObject({
      id: before.id,
      identifier: before.identifier,
      name: "New Display Name"
    });
  });
});
