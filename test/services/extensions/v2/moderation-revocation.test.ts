import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { wrapD1WithHook } from "./db-interceptor";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  post,
  sampleContent
} from "./harness";
import {
  insertUser,
  insertDeveloper,
  insertExtension,
  insertRevision,
  insertDeveloperClaim,
  getDeveloper,
  getExtension,
  getRevision,
  getDeveloperClaim
} from "./db-fixtures";

vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);
setupExtensionsV2Tests();

const actions = [
  "revision approve",
  "revision reject",
  "developer approve",
  "claim approve",
  "claim reject",
  "delist"
] as const;

async function snapshot() {
  return {
    developer: await getDeveloper(db, "review-developer"),
    extension: await getExtension(db, "review-extension"),
    revision: await getRevision(db, "review-revision"),
    claim: await getDeveloperClaim(db, "review-claim"),
    competitor: await getDeveloperClaim(db, "competing-claim")
  };
}

describe("commit-time moderator authority", () => {
  for (const action of actions) {
    it.each(["demoted", "inactive", "moderator"] as const)(
      `${action} checks a %s actor at the write`,
      async (actorState) => {
        await insertUser(db, { id: "reviewer", is_moderator: 1 });
        const claimAction = action.startsWith("claim");
        await insertDeveloper(db, {
          id: "review-developer",
          type: "individual",
          name: "Developer",
          owner_user_id: claimAction ? null : "owner"
        });
        await insertExtension(db, {
          id: "review-extension",
          developer_id: "review-developer"
        });
        await insertRevision(db, {
          id: "review-revision",
          extension_id: "review-extension",
          developer_id: "review-developer",
          submitted_by: "owner",
          content: JSON.stringify(sampleContent({ name: "Reviewed content" }))
        });
        await insertDeveloperClaim(db, {
          id: "review-claim",
          developer_id: "review-developer",
          claimant_id: "claimant"
        });
        await insertDeveloperClaim(db, {
          id: "competing-claim",
          developer_id: "review-developer",
          claimant_id: "competitor"
        });
        const headers = await authHeaders("reviewer");
        const before = await snapshot();
        const table = action.startsWith("revision")
          ? "extension_revisions"
          : claimAction
            ? "developer_claims"
            : action === "delist"
              ? "extensions"
              : "developers";
        let reachedWrite = false;
        env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
          if (
            !reachedWrite &&
            new RegExp(`^\\s*update\\s+"?${table}"?\\s`, "i").test(sql)
          ) {
            reachedWrite = true;
            if (actorState === "demoted") {
              await db
                .prepare(
                  "UPDATE users SET is_moderator = 0 WHERE id = 'reviewer'"
                )
                .run();
            } else if (actorState === "inactive") {
              // Both fields change: inactive takes precedence over demotion.
              await db
                .prepare(
                  "UPDATE users SET is_moderator = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = 'reviewer'"
                )
                .run();
            }
          }
        });
        const path = action.startsWith("revision")
          ? `/extensions/v2/extensions/review-extension/revisions/review-revision/${action.split(" ")[1]}`
          : claimAction
            ? `/extensions/v2/developers/claims/review-claim/${action.split(" ")[1]}`
            : action === "delist"
              ? "/extensions/v2/extensions/review-extension/delist"
              : "/extensions/v2/developers/review-developer/approve";
        const res = await post(path, headers, {
          ...(action.endsWith("reject")
            ? { review_note: "Review decision" }
            : {}),
          ...(action === "delist" ? { reason: "Upstream removed" } : {}),
          ...(action === "developer approve"
            ? {
                expected_revision: 1,
                expected_generation: before.developer!.profile_generation
              }
            : {})
        });
        expect(reachedWrite).toBe(true);
        if (actorState !== "moderator") {
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({
            error: {
              code: actorState === "demoted" ? "FORBIDDEN" : "ACCOUNT_INACTIVE"
            }
          });
          // Includes published content, ownership/epochs, and competing claims.
          expect(await snapshot()).toEqual(before);
        } else {
          expect(res.status).toBe(200);
          const after = await snapshot();
          if (action === "revision approve") {
            expect(after.revision?.status).toBe("approved");
            expect(after.extension?.published_revision_id).toBe(
              "review-revision"
            );
            expect(after.extension?.name).toBe("Reviewed content");
          } else if (action === "revision reject") {
            expect(after.revision?.status).toBe("rejected");
            expect(after.extension).toEqual(before.extension);
          } else if (action === "developer approve") {
            expect(after.developer?.approved_revision).toBe(1);
            expect(after.developer?.approved_by).toBe("reviewer");
          } else if (action === "claim approve") {
            expect(after.claim?.status).toBe("approved");
            expect(after.developer?.owner_user_id).toBe("claimant");
            expect(after.competitor?.status).toBe("rejected");
          } else if (action === "claim reject") {
            expect(after.claim?.status).toBe("rejected");
            expect(after.developer).toEqual(before.developer);
            expect(after.competitor).toEqual(before.competitor);
          } else {
            expect(after.extension?.delisted_at).not.toBeNull();
            expect(after.extension?.delist_reason).toBe("Upstream removed");
          }
        }
      }
    );
  }
});
