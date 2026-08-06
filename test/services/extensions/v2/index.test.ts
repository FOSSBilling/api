import { describe, it, expect, vi } from "vitest";
import { setupExtensionsV2Tests, get } from "./harness";

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

setupExtensionsV2Tests();

describe("Extensions API v2", () => {
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
          "/extensions",
          "/extensions/mine",
          "/extensions/{id}",
          "/users/me/identity",
          "/users/me",
          "/submissions",
          "/submissions/mine",
          "/submissions/queue",
          "/submissions/{id}/approve",
          "/submissions/{id}/reject",
          "/developers/me",
          "/developers/{id}",
          "/developers/unapproved",
          "/developers/{id}/approve",
          "/developers/{id}/transfer",
          "/developers/{id}/transfer/revoke",
          "/developers/transfers/accept",
          "/developers/{id}/claim",
          "/developers/claims/{id}/cancel",
          "/developers/claims/mine",
          "/developers/claims",
          "/developers/claims/{id}/approve",
          "/developers/claims/{id}/reject"
        ])
      );

      const paths = spec.paths as Record<
        string,
        {
          get?: {
            parameters?: Array<{ name?: string }>;
            responses?: Record<string, unknown>;
          };
          patch?: { responses?: Record<string, unknown> };
        }
      >;
      expect(paths["/extensions/mine"].get?.responses).toHaveProperty("403");
      expect(
        paths["/extensions/mine"].get?.parameters?.map(({ name }) => name)
      ).not.toContain("developer_id");
      expect(paths["/users/me"].patch?.responses).toHaveProperty("403");
    });

    it("serves the Scalar API reference UI", async () => {
      const res = await get("/extensions/v2/docs", {});
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    });
  });
});
