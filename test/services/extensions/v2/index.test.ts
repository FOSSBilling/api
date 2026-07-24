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

    it("creates a pending submission for a brand-new extension and author", async () => {
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
  });

  describe("GET /submissions/mine", () => {
    it("returns only the caller's own submissions", async () => {
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
          "/submissions/{id}/reject"
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
