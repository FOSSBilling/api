import { describe, expect, it, vi } from "vitest";
import {
  setupExtensionsV2Tests,
  seedDeveloper,
  authHeaders,
  post,
  put,
  get,
  sampleCreate,
  sampleContent,
  db
} from "./harness";
import { StoredExtensionContentSchema } from "../../../../src/services/extensions/v2/schemas/extensions";
import { insertExtension, insertUser } from "./db-fixtures";

vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);
setupExtensionsV2Tests();

describe("manifest v1 publishing", () => {
  it("publishes package metadata unchanged and keeps ownership distinct from attribution", async () => {
    await seedDeveloper("owner", "user-1");
    await insertUser(db, { id: "moderator", is_moderator: 1 });
    const content = {
      ...sampleCreate({ extensionId: "my_module" }),
      author: { name: "Package Author", url: "https://author.example.com" },
      icon_url: "assets/icon.svg",
      license: "MIT OR Apache-2.0",
      requires: {
        fossbilling: "^0.8.9 || ^1.0",
        php: ">=8.3 <9",
        modules: { branding: "^1.2" }
      }
    };
    const created = await post(
      "/extensions/v2/extensions",
      await authHeaders("user-1"),
      content
    );
    expect(created.status).toBe(201);
    const { result } = (await created.json()) as {
      result: { revision_id: string };
    };
    expect(
      (
        await post(
          `/extensions/v2/extensions/my_module/revisions/${result.revision_id}/approve`,
          await authHeaders("moderator"),
          {}
        )
      ).status
    ).toBe(200);
    const detail = await get("/extensions/v2/extensions/my_module", {});
    const { result: extension } = (await detail.json()) as {
      result: Record<string, unknown>;
    };
    expect(extension).toMatchObject({
      ...content,
      developer: { identifier: "owner" }
    });
    expect(extension).not.toHaveProperty("website");
    const list = await get("/extensions/v2/extensions?type=module", {});
    const { result: items } = (await list.json()) as {
      result: Record<string, unknown>[];
    };
    expect(items[0]).not.toHaveProperty("requires");
    const updated = {
      ...sampleContent(),
      author: content.author,
      requires: { fossbilling: ">=1.0.0", php: ">=8.4" }
    };
    const edit = await put(
      "/extensions/v2/extensions/my_module",
      await authHeaders("user-1"),
      updated
    );
    expect(edit.status).toBe(202);
    const { result: revision } = (await edit.json()) as {
      result: { revision_id: string };
    };
    expect(
      (
        await post(
          `/extensions/v2/extensions/my_module/revisions/${revision.revision_id}/approve`,
          await authHeaders("moderator"),
          {}
        )
      ).status
    ).toBe(200);
    await expect(
      (await get("/extensions/v2/extensions/my_module", {})).json()
    ).resolves.toMatchObject({
      result: { requires: updated.requires, license: "MIT" }
    });
    const legacyList = await get("/extensions/v1/list?type=mod", {});
    await expect(legacyList.json()).resolves.toMatchObject({
      result: [{ id: "my_module", type: "mod" }]
    });
    const legacy = await get("/extensions/v1/my_module", {});
    expect(legacy.status).toBe(200);
    await expect(legacy.json()).resolves.toMatchObject({
      result: {
        type: "mod",
        website: "https://example.com",
        license: { name: "MIT" }
      }
    });
  });

  it("publishes without an additional PHP restriction", async () => {
    await seedDeveloper("owner", "user-1");
    await insertUser(db, { id: "moderator", is_moderator: 1 });
    const fixture = sampleCreate();
    const requires = { fossbilling: "^0.8.9" };
    const content = {
      ...fixture,
      requires,
      releases: fixture.releases.map((release) => ({ ...release, requires }))
    };
    const created = await post(
      "/extensions/v2/extensions",
      await authHeaders("user-1"),
      content
    );
    expect(created.status).toBe(201);
    const { result } = (await created.json()) as {
      result: { revision_id: string };
    };
    expect(
      (
        await post(
          `/extensions/v2/extensions/${content.identifier}/revisions/${result.revision_id}/approve`,
          await authHeaders("moderator"),
          {}
        )
      ).status
    ).toBe(200);
    const published = (await (
      await get(`/extensions/v2/extensions/${content.identifier}`, {})
    ).json()) as { result: typeof content };
    expect(published.result.requires).toEqual(requires);
    expect(published.result.releases[0].requires).toEqual(requires);
    expect((await get(`/extensions/v1/${content.identifier}`, {})).status).toBe(
      200
    );
  });

  it("keeps the historical minimum-version field bounded in revision schemas", () => {
    const content = (minimum: string) => ({
      releases: [
        { ...sampleContent().releases[0], min_fossbilling_version: minimum }
      ]
    });
    expect(
      StoredExtensionContentSchema.safeParse(content("x".repeat(100))).success
    ).toBe(true);
    const oversized = StoredExtensionContentSchema.safeParse(
      content("x".repeat(101))
    );
    expect(oversized.success).toBe(false);
    if (!oversized.success)
      expect(oversized.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "too_big",
            path: ["releases", 0, "min_fossbilling_version"]
          })
        ])
      );
  });

  it("rejects the retired website key specifically as an unknown root field", async () => {
    await seedDeveloper("owner", "user-1");
    const response = await post(
      "/extensions/v2/extensions",
      await authHeaders("user-1"),
      { ...sampleCreate(), website: "https://example.com" }
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        details: expect.arrayContaining([
          expect.objectContaining({
            code: "unrecognized_keys",
            keys: ["website"],
            path: []
          })
        ])
      }
    });
  });

  it("allows existing long identities to be edited without relaxing new manifest IDs", async () => {
    await seedDeveloper("owner", "user-1");
    const id = "e".repeat(120);
    await insertExtension(db, {
      identifier: id,
      developer_identifier: "owner"
    });
    expect(
      (
        await put(
          `/extensions/v2/extensions/${id}`,
          await authHeaders("user-1"),
          sampleContent()
        )
      ).status
    ).toBe(202);
  });

  it("accepts an omitted homepage and rejects old fields and unsafe package paths", async () => {
    await seedDeveloper("owner", "user-1");
    const headers = await authHeaders("user-1");
    const { homepage_url: _homepage, ...content } = sampleCreate();
    for (const invalid of [
      { type: "mod" },
      { manifest_version: 2 },
      { license: { name: "MIT" } },
      { version: "v1.0.0" },
      { version: "01.0.0" },
      { version: "1.0.0+" + "x".repeat(100) },
      { description: "x".repeat(501) },
      { name: "x".repeat(101) },
      { requires: { fossbilling: "^1", php: null } },
      { requires: { fossbilling: "   ", php: ">=8.3" } },
      { requires: { fossbilling: "^1", php: "   " } },
      {
        requires: {
          fossbilling: "^1",
          php: ">=8.3",
          modules: { branding: "   " }
        }
      },
      {
        requires: {
          fossbilling: "^1",
          php: "^8",
          modules: { "bad/dependency": "*" }
        }
      },
      ...[
        "../icon.svg",
        "/icon.svg",
        "https://example.com/icon.svg",
        "a\\icon.svg"
      ].map((icon_url) => ({ icon_url }))
    ])
      expect(
        (
          await post("/extensions/v2/extensions", headers, {
            ...content,
            ...invalid
          })
        ).status
      ).toBe(422);
    expect(
      (await post("/extensions/v2/extensions", headers, content)).status
    ).toBe(201);
  });
});
