import { describe, it, expect, beforeEach } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../../../src/app";
import { createMockD1, createTables, MockTables } from "./mock-db";
import { signAssertion } from "../../../lib/auth/assertion-helper";

// Matches the ASSERTION_SIGNING_SECRET binding configured in vitest.config.ts.
const SECRET = "test-assertion-signing-secret";

let tables: MockTables;

beforeEach(() => {
  tables = createTables();
  env.DB_EXTENSIONS = createMockD1(tables);
});

async function authHeaders(sub: string): Promise<Record<string, string>> {
  const token = await signAssertion(SECRET, { sub });
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

function samplePayload(overrides?: {
  extensionId?: string;
  authorId?: string;
}) {
  return {
    author: {
      id: overrides?.authorId ?? "new-author",
      type: "user",
      name: "Some Author",
      URL: "https://example.com"
    },
    extension: {
      id: overrides?.extensionId ?? "new-ext",
      type: "mod",
      name: "New Extension",
      description: "A new extension",
      releases: [
        {
          tag: "1.0.0",
          date: "2026-01-01T00:00:00Z",
          download_url: "https://example.com/download.zip",
          min_fossbilling_version: "0.6"
        }
      ],
      website: "https://example.com",
      license: { name: "MIT" },
      readme: "# Readme",
      source: { type: "github", repo: "example/new-ext" },
      version: "1.0.0",
      download_url: "https://example.com/download.zip"
    }
  };
}

// Extension submissions now require the named author to already exist
// (created via PUT /authors/me) and be owned by the caller.
function seedAuthor(id: string, ownerUserId: string): void {
  tables.authors.set(id, {
    id,
    type: "user",
    name: "Author",
    url: null,
    owner_user_id: ownerUserId
  });
}

function seedOwnedExtension(): void {
  tables.authors.set("owner-author", {
    id: "owner-author",
    type: "user",
    name: "Owner",
    url: null,
    owner_user_id: "owner-1"
  });
  tables.extensions.set("existing-ext", {
    id: "existing-ext",
    type: "mod",
    author_id: "owner-author",
    name: "Existing",
    description: "d",
    releases: "[]",
    website: "https://e.com",
    license: '{"name":"MIT"}',
    icon_url: null,
    readme: "r",
    source: '{"type":"github","repo":"example/existing"}',
    version: "1.0.0",
    download_url: "https://e.com/d.zip"
  });
}

async function post(
  path: string,
  headers: Record<string, string>,
  body?: unknown
) {
  const ctx = createExecutionContext();
  const res = await app.request(
    path,
    {
      method: "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    },
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function get(path: string, headers: Record<string, string>) {
  const ctx = createExecutionContext();
  const res = await app.request(path, { headers }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function put(
  path: string,
  headers: Record<string, string>,
  body?: unknown
) {
  const ctx = createExecutionContext();
  const res = await app.request(
    path,
    {
      method: "PUT",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    },
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function sampleAuthor(overrides?: { id?: string; name?: string }) {
  return {
    id: overrides?.id ?? "dev-author",
    type: "user",
    name: overrides?.name ?? "Dev Author",
    URL: "https://example.com"
  };
}

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
        author: {},
        extension: {}
      });
      expect(res.status).toBe(422);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects profile fields (bio/avatar_url/contact_email) on a submission's author", async () => {
      seedAuthor("new-author", "user-1");
      const headers = await authHeaders("user-1");
      const payload = samplePayload();
      const res = await post("/extensions/v2/submissions", headers, {
        ...payload,
        author: { ...payload.author, bio: "Should not be accepted here" }
      });

      expect(res.status).toBe(422);
      expect(tables.extension_submissions.size).toBe(0);
    });

    it("creates a pending submission for a brand-new extension under an existing author", async () => {
      seedAuthor("new-author", "user-1");
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
      expect(tables.extension_submissions.size).toBe(1);

      const stored = [...tables.extension_submissions.values()][0];
      expect(stored.extension_id).toBeNull();
      expect(stored.submitted_by).toBe("user-1");
    });

    it("rejects editing an extension not owned by the caller", async () => {
      seedOwnedExtension();
      const headers = await authHeaders("intruder");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({ extensionId: "existing-ext", authorId: "owner-author" })
      );

      expect(res.status).toBe(403);
      expect(tables.extension_submissions.size).toBe(0);
    });

    it("allows editing an extension owned by the caller", async () => {
      seedOwnedExtension();
      const headers = await authHeaders("owner-1");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({ extensionId: "existing-ext", authorId: "owner-author" })
      );

      expect(res.status).toBe(201);
      const stored = [...tables.extension_submissions.values()][0];
      expect(stored.extension_id).toBe("existing-ext");
    });

    it("rejects claiming an author already owned by someone else", async () => {
      seedOwnedExtension();
      const headers = await authHeaders("intruder");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({
          extensionId: "another-new-ext",
          authorId: "owner-author"
        })
      );

      expect(res.status).toBe(403);
    });

    it("rejects naming an author id that doesn't exist at all", async () => {
      const headers = await authHeaders("user-1");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({ authorId: "no-such-author" })
      );

      expect(res.status).toBe(403);
      expect(tables.extension_submissions.size).toBe(0);
    });
  });

  describe("GET /submissions/mine", () => {
    it("returns only the caller's own submissions", async () => {
      seedAuthor("author-a", "user-1");
      seedAuthor("author-b", "user-2");
      await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload({ extensionId: "ext-a", authorId: "author-a" })
      );
      await post(
        "/extensions/v2/submissions",
        await authHeaders("user-2"),
        samplePayload({ extensionId: "ext-b", authorId: "author-b" })
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
  });

  describe("GET /submissions/queue", () => {
    it("requires moderator access", async () => {
      const res = await get(
        "/extensions/v2/submissions/queue",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(403);
    });

    it("returns pending submissions for a moderator", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedAuthor("new-author", "user-1");
      await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );

      const res = await get(
        "/extensions/v2/submissions/queue",
        await authHeaders("mod-1")
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: Array<{ status: string }> };
      expect(data.result).toHaveLength(1);
      expect(data.result[0].status).toBe("pending");
    });
  });

  describe("approve / reject", () => {
    it("reverts to pending if the write-through fails after a successful claim", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedAuthor("new-author", "user-1");

      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      tables.forceExtensionWriteFailure = true;
      const approved = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(500);
      expect(tables.extensions.size).toBe(0);

      const stored = tables.extension_submissions.get(result.id);
      expect(stored?.status).toBe("pending");

      // Recovers cleanly once the underlying failure is gone.
      tables.forceExtensionWriteFailure = false;
      const retried = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(retried.status).toBe(200);
      expect(tables.extensions.size).toBe(1);
    });

    it("approves a submission and it becomes visible via the v1 read path", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedAuthor("new-author", "user-1");

      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      const approved = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(200);
      const approvedBody = (await approved.json()) as {
        result: { status: string };
      };
      expect(approvedBody.result.status).toBe("approved");

      const v1Res = await get("/extensions/v1/new-ext", {});
      expect(v1Res.status).toBe(200);
      const v1Body = (await v1Res.json()) as {
        result: { id: string; author: { id: string } };
      };
      expect(v1Body.result.id).toBe("new-ext");
      expect(v1Body.result.author.id).toBe("new-author");
    });

    it("blocks non-moderators from approving", async () => {
      seedAuthor("new-author", "user-1");
      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      const res = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(403);
    });

    it("rejects approving a submission that is not pending", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedAuthor("new-author", "user-1");
      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      const secondApprove = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(secondApprove.status).toBe(409);
      // The second (raced) approve must not write through again.
      expect(tables.extensions.size).toBe(1);
    });

    it("updates the existing row instead of duplicating it when an edit's id differs only by case", async () => {
      tables.authors.set("owner-author", {
        id: "owner-author",
        type: "user",
        name: "Owner",
        url: null,
        owner_user_id: "owner-1"
      });
      // Legacy v1 data can have mixed-case ids; v2 submissions must be lowercase.
      tables.extensions.set("Existing-Ext", {
        id: "Existing-Ext",
        type: "mod",
        author_id: "owner-author",
        name: "Existing",
        description: "d",
        releases: "[]",
        website: "https://e.com",
        license: '{"name":"MIT"}',
        icon_url: null,
        readme: "r",
        source: '{"type":"github","repo":"example/existing"}',
        version: "1.0.0",
        download_url: "https://e.com/d.zip"
      });
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("owner-1"),
        samplePayload({ extensionId: "existing-ext", authorId: "owner-author" })
      );
      const { result } = (await created.json()) as { result: { id: string } };

      const approved = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(200);

      expect(tables.extensions.size).toBe(1);
      const stored = tables.extensions.get("Existing-Ext");
      expect(stored?.name).toBe("New Extension");
    });

    it("requires a review_note to reject", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedAuthor("new-author", "user-1");
      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      const res = await post(
        `/extensions/v2/submissions/${result.id}/reject`,
        await authHeaders("mod-1"),
        {}
      );
      expect(res.status).toBe(422);
    });

    it("rejects a submission with a note", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedAuthor("new-author", "user-1");
      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      const res = await post(
        `/extensions/v2/submissions/${result.id}/reject`,
        await authHeaders("mod-1"),
        { review_note: "Needs a valid license URL" }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { status: string } };
      expect(body.result.status).toBe("rejected");
      expect(tables.extensions.size).toBe(0);
    });
  });

  describe("PUT /authors/me", () => {
    it("creates a new author profile, unapproved", async () => {
      const res = await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor()
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: { approved: boolean } };
      expect(data.result.approved).toBe(false);

      const stored = tables.authors.get("dev-author");
      expect(stored).toBeDefined();
      expect(stored?.approved_at).toBeNull();
    });

    it("updates an existing profile, still unapproved", async () => {
      await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor()
      );

      const res = await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor({ name: "Renamed Author" })
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: { name: string; approved: boolean };
      };
      expect(data.result.name).toBe("Renamed Author");
      expect(data.result.approved).toBe(false);
      expect(tables.authors.get("dev-author")?.name).toBe("Renamed Author");
    });

    it("only lets one of two concurrent first-time profile creations by the same caller win", async () => {
      const headers = await authHeaders("user-1");
      const [resA, resB] = await Promise.all([
        put(
          "/extensions/v2/authors/me",
          headers,
          sampleAuthor({ id: "author-a" })
        ),
        put(
          "/extensions/v2/authors/me",
          headers,
          sampleAuthor({ id: "author-b" })
        )
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const ownedAuthors = [...tables.authors.values()].filter(
        (a) => a.owner_user_id === "user-1"
      );
      expect(ownedAuthors).toHaveLength(1);
    });

    it("rejects an id that already belongs to someone else", async () => {
      await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor()
      );

      const res = await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-2"),
        sampleAuthor()
      );

      expect(res.status).toBe(409);
    });

    it("rejects changing the id on an existing profile", async () => {
      await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor()
      );

      const res = await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor({ id: "different-id" })
      );

      expect(res.status).toBe(409);
    });

    it("clears approval when an approved profile is edited", async () => {
      await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor()
      );
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      const approved = await post(
        "/extensions/v2/authors/dev-author/approve",
        await authHeaders("mod-1")
      );
      expect(approved.status).toBe(200);
      const approvedBody = (await approved.json()) as {
        result: { approved: boolean };
      };
      expect(approvedBody.result.approved).toBe(true);

      const res = await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor({ name: "Edited Again" })
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: { approved: boolean } };
      expect(data.result.approved).toBe(false);
    });

    it("round-trips bio, avatar_url, and contact_email", async () => {
      const headers = await authHeaders("user-1");
      const res = await put("/extensions/v2/authors/me", headers, {
        ...sampleAuthor(),
        bio: "I build FOSSBilling extensions.",
        avatar_url: "https://example.com/avatar.png",
        contact_email: "dev@example.com"
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: {
          bio: string;
          avatar_url: string;
          contact_email: string;
        };
      };
      expect(data.result.bio).toBe("I build FOSSBilling extensions.");
      expect(data.result.avatar_url).toBe("https://example.com/avatar.png");
      expect(data.result.contact_email).toBe("dev@example.com");

      const stored = tables.authors.get("dev-author");
      expect(stored?.bio).toBe("I build FOSSBilling extensions.");
      expect(stored?.avatar_url).toBe("https://example.com/avatar.png");
      expect(stored?.contact_email).toBe("dev@example.com");
    });

    it("updates bio, avatar_url, and contact_email on an existing profile", async () => {
      const headers = await authHeaders("user-1");
      await put("/extensions/v2/authors/me", headers, {
        ...sampleAuthor(),
        bio: "Old bio.",
        avatar_url: "https://example.com/old.png",
        contact_email: "old@example.com"
      });

      const res = await put("/extensions/v2/authors/me", headers, {
        ...sampleAuthor(),
        bio: "New bio.",
        avatar_url: "https://example.com/new.png",
        contact_email: "new@example.com"
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: {
          bio: string;
          avatar_url: string;
          contact_email: string;
        };
      };
      expect(data.result.bio).toBe("New bio.");
      expect(data.result.avatar_url).toBe("https://example.com/new.png");
      expect(data.result.contact_email).toBe("new@example.com");

      const stored = tables.authors.get("dev-author");
      expect(stored?.bio).toBe("New bio.");
      expect(stored?.avatar_url).toBe("https://example.com/new.png");
      expect(stored?.contact_email).toBe("new@example.com");
    });

    it("accepts a payload without bio, avatar_url, or contact_email", async () => {
      const res = await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor()
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: {
          bio?: string;
          avatar_url?: string;
          contact_email?: string;
        };
      };
      expect(data.result.bio).toBeUndefined();
      expect(data.result.avatar_url).toBeUndefined();
      expect(data.result.contact_email).toBeUndefined();
    });
  });

  describe("author moderation", () => {
    it("approves an author and removes it from the unapproved list", async () => {
      await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor()
      );
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

      const approve = await post(
        "/extensions/v2/authors/dev-author/approve",
        await authHeaders("mod-1")
      );
      expect(approve.status).toBe(200);
      const approveBody = (await approve.json()) as {
        result: { id: string; approved: boolean };
      };
      expect(approveBody.result).toEqual({ id: "dev-author", approved: true });

      const unapproved = await get(
        "/extensions/v2/authors/unapproved",
        await authHeaders("mod-1")
      );
      expect(unapproved.status).toBe(200);
      const unapprovedBody = (await unapproved.json()) as {
        result: Array<{ id: string }>;
      };
      expect(unapprovedBody.result.map((a) => a.id)).not.toContain(
        "dev-author"
      );
    });

    it("404s approving a nonexistent author", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

      const res = await post(
        "/extensions/v2/authors/no-such-author/approve",
        await authHeaders("mod-1")
      );
      expect(res.status).toBe(404);
    });

    it("blocks non-moderators from listing unapproved authors", async () => {
      const res = await get(
        "/extensions/v2/authors/unapproved",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(403);
    });

    it("blocks non-moderators from approving authors", async () => {
      await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor()
      );

      const res = await post(
        "/extensions/v2/authors/dev-author/approve",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(403);
    });
  });

  describe("GET /authors/{id}/history", () => {
    it("records a history entry for a newly created profile", async () => {
      await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor()
      );
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

      const res = await get(
        "/extensions/v2/authors/dev-author/history",
        await authHeaders("mod-1")
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: Array<{
          author_id: string;
          name: string;
          changed_by: string;
        }>;
      };
      expect(data.result).toHaveLength(1);
      expect(data.result[0].author_id).toBe("dev-author");
      expect(data.result[0].name).toBe("Dev Author");
      expect(data.result[0].changed_by).toBe("user-1");
    });

    it("orders entries newest-first and snapshots each write", async () => {
      await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor({ name: "Original Name" })
      );
      await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor({ name: "Edited Name" })
      );
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

      const res = await get(
        "/extensions/v2/authors/dev-author/history",
        await authHeaders("mod-1")
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: Array<{ name: string }>;
      };
      expect(data.result).toHaveLength(2);
      expect(data.result[0].name).toBe("Edited Name");
      expect(data.result[1].name).toBe("Original Name");
    });

    it("returns an empty array for an author with no history", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

      const res = await get(
        "/extensions/v2/authors/no-such-author/history",
        await authHeaders("mod-1")
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: unknown[] };
      expect(data.result).toEqual([]);
    });

    it("blocks non-moderators", async () => {
      await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor()
      );

      const res = await get(
        "/extensions/v2/authors/dev-author/history",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(403);
    });

    it("does not record history for a rejected write (id already taken)", async () => {
      await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-1"),
        sampleAuthor()
      );

      const res = await put(
        "/extensions/v2/authors/me",
        await authHeaders("user-2"),
        sampleAuthor()
      );
      expect(res.status).toBe(409);

      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      const history = await get(
        "/extensions/v2/authors/dev-author/history",
        await authHeaders("mod-1")
      );
      const data = (await history.json()) as { result: unknown[] };
      expect(data.result).toHaveLength(1);
    });
  });

  describe("OpenAPI docs", () => {
    it("serves a generated OpenAPI document", async () => {
      const res = await get("/extensions/v2/openapi.json", {});
      expect(res.status).toBe(200);
      const spec = (await res.json()) as {
        openapi: string;
        paths: Record<string, unknown>;
      };
      expect(spec.openapi).toBe("3.1.0");
      expect(Object.keys(spec.paths)).toEqual(
        expect.arrayContaining([
          "/submissions",
          "/submissions/mine",
          "/submissions/queue",
          "/submissions/{id}/approve",
          "/submissions/{id}/reject",
          "/authors/me",
          "/authors/unapproved",
          "/authors/{id}/approve"
        ])
      );
    });

    it("serves the Scalar API reference UI", async () => {
      const res = await get("/extensions/v2/docs", {});
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    });
  });
});
