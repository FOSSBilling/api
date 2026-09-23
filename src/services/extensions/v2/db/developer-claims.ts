import { and, asc, desc, eq, gt, isNull, lt, or, sql, SQL } from "drizzle-orm";
import { DatabaseResult } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { encodeCursor as encode, decodeCursor as decode } from "./cursor";
import { developerClaims, developers, users } from "./schema";
import {
  databaseError,
  isDeveloperOwnerConflict,
  isOwnershipEpochRollback
} from "./errors";
import { toD1Statement } from "./batch";
import { optionalBool } from "./columns";
import { Developer, DeveloperProfile } from "../schemas/developers";
import { DeveloperClaim, PendingDeveloperClaim } from "../schemas/ownership";
import { DeveloperProfilesDatabase } from "./developer-profiles";
import { verifyGithubOwnership } from "../github/identity";

type ClaimRow = typeof developerClaims.$inferSelect;

function parseClaimRow(row: ClaimRow): DeveloperClaim {
  return {
    id: row.id,
    developer_id: row.developerId,
    claimant_id: row.claimantId,
    status: row.status as DeveloperClaim["status"],
    note: row.note ?? undefined,
    review_note: row.reviewNote ?? undefined,
    reviewer_id: row.reviewerId ?? undefined,
    created_at: row.createdAt,
    reviewed_at: row.reviewedAt ?? undefined,
    github_org_verified: optionalBool(row.githubOrgVerified),
    github_verification_note: row.githubVerificationNote ?? undefined
  };
}

export class DeveloperClaimsDatabase {
  constructor(private db: ExtensionsDb) {}

  // Public for the claim-approve route, which reads the claimant before
  // approveClaim() transfers ownership and the row stops naming them.
  async getClaimById(id: string): Promise<DatabaseResult<DeveloperClaim>> {
    try {
      const [row] = await this.db
        .select()
        .from(developerClaims)
        .where(eq(developerClaims.id, id));
      if (!row) {
        return {
          data: null,
          error: {
            message: `Cannot find claim by id: ${id}`,
            code: "NOT_FOUND"
          }
        };
      }
      return { data: parseClaimRow(row), error: null };
    } catch (error) {
      return databaseError("getClaimById", error);
    }
  }

  // Used by claim once a developer/eligibility-guarded write
  // affects zero rows: distinguishes an inactive claimant, "no such
  // developer", and the two possible ownership conflicts for an accurate
  // response, without reopening the race the guarded write already closed.
  private async claimIneligibilityError(
    developerId: string,
    claimantId: string
  ): Promise<{
    code: "NOT_FOUND" | "CONFLICT" | "ACCOUNT_INACTIVE";
    message: string;
  }> {
    const [developer] = await this.db
      .select({ ownerUserId: developers.ownerUserId })
      .from(developers)
      .where(eq(developers.id, developerId));
    if (!developer) {
      return { code: "NOT_FOUND", message: "Developer not found" };
    }

    const [claimant] = await this.db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, claimantId));
    if (!claimant || claimant.deletedAt !== null) {
      return {
        code: "ACCOUNT_INACTIVE",
        message: "Active account required"
      };
    }

    if (developer.ownerUserId !== null) {
      return { code: "CONFLICT", message: "This profile is already owned" };
    }

    const [ownProfile] = await this.db
      .select({ id: developers.id })
      .from(developers)
      .where(eq(developers.ownerUserId, claimantId));
    if (ownProfile) {
      return {
        code: "CONFLICT",
        message: "You already have a developer profile"
      };
    }

    // Every condition in the insert's WHERE guard holds, so the row was
    // rejected by the pending-claim partial unique index instead - the
    // claimant is replaying a claim they already have open here.
    return {
      code: "CONFLICT",
      message: "You already have a pending claim on this profile"
    };
  }

  async claim(
    developerId: string,
    claimantId: string,
    note?: string,
    githubToken?: string
  ): Promise<DatabaseResult<DeveloperClaim>> {
    try {
      let githubOrgVerified: number | null = null;
      let githubVerificationNote: string | null = null;

      const [developer] = await this.db
        .select({ type: developers.type })
        .from(developers)
        .where(
          and(eq(developers.id, developerId), isNull(developers.ownerUserId))
        );

      if (developer) {
        // Cheap short-circuit ahead of the GitHub lookup below: a claimant
        // replaying an already-pending claim on this id would otherwise
        // trigger a fresh GitHub API call every time, purely to be told the
        // INSERT's own guard rejects it as a duplicate — letting one caller
        // burn through the shared service-level GitHub quota for free. This
        // is safe precisely because it only ever *returns* here when the
        // read observes `pending` — it never falls through to verification
        // or the INSERT in that case, so it can't itself create an
        // unverified claim. Anything else (no claim yet, or one already
        // resolved to approved/rejected) always continues through full
        // verification below. A pending claim that resolves between this
        // read and the response going out can make the message stale
        // relative to that instant, but never lets a row get created
        // without verification.
        const [hasPendingClaim] = await this.db
          .select({ one: sql`1` })
          .from(developerClaims)
          .where(
            and(
              eq(developerClaims.developerId, developerId),
              eq(developerClaims.claimantId, claimantId),
              eq(developerClaims.status, "pending")
            )
          );

        if (hasPendingClaim) {
          return {
            data: null,
            error: {
              code: "CONFLICT",
              message: "You already have a pending claim on this profile"
            }
          };
        }

        const check = await verifyGithubOwnership(
          this.db,
          developerId,
          developer.type as Developer["type"],
          claimantId,
          githubToken
        );

        if ("error" in check) {
          return { data: null, error: check.error };
        }

        if (check.mismatch) {
          return {
            data: null,
            error: {
              code: "GITHUB_MISMATCH",
              message:
                "Your linked GitHub account doesn't match this developer's GitHub organization or username, so it can't be claimed automatically. Make sure you're signed in with the right GitHub account, then try again."
            }
          };
        }

        githubOrgVerified = check.githubOrgVerified;
        githubVerificationNote = check.note;
      }

      const id = crypto.randomUUID();
      let result;
      try {
        // Both eligibility checks are folded into the INSERT itself, rather
        // than a separate SELECT beforehand — a caller who loses eligibility
        // (developer gets claimed/transferred, or the caller picks up a
        // different profile) between an up-front check and the write could
        // otherwise still slip a stale claim through. (The SELECT above is
        // only used to decide the GitHub verification signal, and is always
        // re-checked here — it can't itself grant eligibility.) Kept as raw
        // sql: an INSERT...SELECT...WHERE EXISTS isn't expressible via
        // .insert().values().
        // ON CONFLICT DO NOTHING turns a lost race against the pending-claim
        // partial unique index into changes = 0, which the ineligibility
        // diagnosis below already has to explain.
        result = await this.db.run(sql`
          INSERT INTO ${developerClaims} (id, developer_id, claimant_id, note, github_org_verified, github_verification_note)
             SELECT ${id}, ${developerId}, ${claimantId}, ${note ?? null}, ${githubOrgVerified}, ${githubVerificationNote}
             WHERE EXISTS (SELECT 1 FROM ${developers} WHERE id = ${developerId} AND owner_user_id IS NULL)
               AND NOT EXISTS (SELECT 1 FROM ${developers} WHERE owner_user_id = ${claimantId})
               AND EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${claimantId} AND ${users.deletedAt} IS NULL)
          ON CONFLICT DO NOTHING
        `);
      } catch (error) {
        return databaseError("claim", error);
      }

      if (!result.meta?.changes) {
        return {
          data: null,
          error: await this.claimIneligibilityError(developerId, claimantId)
        };
      }

      return this.getClaimById(id);
    } catch (error) {
      return databaseError("claim", error);
    }
  }

  // Lets a claimant withdraw their own pending claim — scoped to
  // claimant_id so this can't be used to cancel someone else's, and to
  // status = 'pending' so a moderator's decision can't be undone by it.
  async cancelClaim(
    claimId: string,
    claimantId: string
  ): Promise<DatabaseResult<{ id: string }>> {
    let result;
    try {
      result = await this.db.delete(developerClaims).where(
        and(
          eq(developerClaims.id, claimId),
          eq(developerClaims.claimantId, claimantId),
          eq(developerClaims.status, "pending"),
          sql`EXISTS (
              SELECT 1 FROM ${users}
              WHERE ${users.id} = ${claimantId} AND ${users.deletedAt} IS NULL
            )`
        )
      );
    } catch (error) {
      return databaseError("cancelClaim", error);
    }

    if (!result.meta?.changes) {
      return {
        data: null,
        error: {
          message: `Cannot find pending claim by id: ${claimId}`,
          code: "NOT_FOUND"
        }
      };
    }

    return { data: { id: claimId }, error: null };
  }

  // Unified reader for the merged GET /developers/claims?scope=. Always
  // returns the enriched Pending shape so mine and pending share one
  // contract; scope=mine is caller-filtered (any status unless narrowed),
  // scope=pending is moderator-wide (pending only — the route rejects any
  // other status filter with 422). The filter is a discriminated union so
  // scope=mine cannot be called without the caller's id, which would
  // otherwise drop the ownership predicate and return every claim in the
  // table.
  //
  // Keyset (cursor) pagination: mine orders newest-first, pending
  // oldest-first (same keys, opposite directions — the cursor comparison
  // flips like ExtensionRevisionsDatabase.page). Ties on created_at are
  // broken by rowid (insertion order), as the offset implementation did.
  async listScoped(
    filters:
      | {
          scope: "mine";
          claimantId: string;
          status?: "pending" | "approved" | "rejected" | "all";
        }
      | {
          scope: "pending";
          status?: "pending" | "approved" | "rejected" | "all";
        },
    page?: { limit?: number; cursor?: string }
  ): Promise<
    DatabaseResult<{
      items: PendingDeveloperClaim[];
      nextCursor: string | null;
      hasMore: boolean;
    }>
  > {
    const limit = page?.limit ?? 50;
    const decoded = page?.cursor ? decodeClaimCursor(page.cursor) : null;
    // Scopes order oppositely (mine newest-first, pending oldest-first),
    // so a cursor from one scope would seek from the wrong key boundary in
    // the other: reject it rather than return a silently wrong page. (The
    // status filter within scope=mine shares the same ordering, so it needs
    // no tag.)
    if (page?.cursor && (!decoded || decoded.s !== filters.scope)) {
      return {
        data: null,
        error: { message: "Invalid pagination cursor", code: "INVALID_CURSOR" }
      };
    }
    const afterRowid = decoded ? Number(decoded.k2) : NaN;
    if (decoded && !Number.isInteger(afterRowid)) {
      return {
        data: null,
        error: { message: "Invalid pagination cursor", code: "INVALID_CURSOR" }
      };
    }
    const status = filters.status ?? "all";
    const newestFirst = filters.scope === "mine";
    try {
      const conditions: SQL[] = [];
      if (filters.scope === "mine") {
        conditions.push(eq(developerClaims.claimantId, filters.claimantId));
      }
      if (filters.scope === "pending" && status === "all") {
        conditions.push(eq(developerClaims.status, "pending"));
      } else if (status !== "all") {
        conditions.push(eq(developerClaims.status, status));
      }
      if (decoded) {
        conditions.push(
          newestFirst
            ? or(
                lt(developerClaims.createdAt, decoded.k1),
                and(
                  eq(developerClaims.createdAt, decoded.k1),
                  sql`"developer_claims".rowid < ${afterRowid}`
                )
              )!
            : or(
                gt(developerClaims.createdAt, decoded.k1),
                and(
                  eq(developerClaims.createdAt, decoded.k1),
                  sql`"developer_claims".rowid > ${afterRowid}`
                )
              )!
        );
      }
      const rows = await this.db
        .select({
          claim: developerClaims,
          developerName: developers.name,
          developerType: developers.type,
          claimantName: users.name,
          claimantGithubLogin: users.githubLogin,
          rowid: sql<number>`"developer_claims".rowid`
        })
        .from(developerClaims)
        .innerJoin(developers, eq(developers.id, developerClaims.developerId))
        .leftJoin(users, eq(users.id, developerClaims.claimantId))
        .where(conditions.length ? and(...conditions)! : undefined)
        .orderBy(
          newestFirst
            ? desc(developerClaims.createdAt)
            : asc(developerClaims.createdAt),
          newestFirst
            ? sql`"developer_claims".rowid DESC`
            : sql`"developer_claims".rowid ASC`
        )
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      return {
        data: {
          items: pageRows.map((row) => ({
            ...parseClaimRow(row.claim),
            developer_name: row.developerName,
            developer_type:
              row.developerType as PendingDeveloperClaim["developer_type"],
            claimant_name: row.claimantName,
            claimant_github_login: row.claimantGithubLogin
          })),
          hasMore,
          nextCursor:
            hasMore && last
              ? encodeClaimCursor(
                  last.claim.createdAt,
                  String(last.rowid),
                  filters.scope
                )
              : null
        },
        error: null
      };
    } catch (error) {
      return databaseError("listScoped", error);
    }
  }

  private async explainClaimApprovalNoOp(
    claim: DeveloperClaim
  ): Promise<DatabaseResult<DeveloperProfile>> {
    const latestClaim = await this.getClaimById(claim.id);
    if (latestClaim.error || latestClaim.data?.status !== "pending") {
      return {
        data: null,
        error: latestClaim.error ?? {
          message: "Claim is not pending",
          code: "CONFLICT"
        }
      };
    }

    try {
      const [developer] = await this.db
        .select({ ownerUserId: developers.ownerUserId })
        .from(developers)
        .where(eq(developers.id, claim.developer_id));
      if (!developer) {
        return {
          data: null,
          error: { message: "Developer not found", code: "NOT_FOUND" }
        };
      }
      if (developer.ownerUserId !== null) {
        return {
          data: null,
          error: { message: "This profile is already owned", code: "CONFLICT" }
        };
      }
      return {
        data: null,
        error: {
          message: "The claimant already owns a different developer profile",
          code: "CONFLICT"
        }
      };
    } catch (error) {
      return databaseError("approveClaim", error);
    }
  }

  async approveClaim(
    claimId: string,
    reviewerId: string
  ): Promise<
    DatabaseResult<{ profile: DeveloperProfile; claim: DeveloperClaim }>
  > {
    const existing = await this.getClaimById(claimId);
    if (existing.error || !existing.data) {
      return {
        data: null,
        error: existing.error ?? {
          message: `Cannot find claim by id: ${claimId}`,
          code: "NOT_FOUND"
        }
      };
    }
    const claim = existing.data;

    if (claim.status !== "pending") {
      return {
        data: null,
        error: { message: "Claim is not pending", code: "CONFLICT" }
      };
    }

    // Keep the status transition, ownership handoff, and competing-claim
    // rejection in one raw D1 batch. Each write is gated by changes() from
    // the immediately preceding statement, so a stale claim cannot transfer
    // ownership and a failed transfer cannot reject competing claims.
    //
    // The assertion statement is intentionally capable of violating the
    // ownership_epoch CHECK. D1 rolls the entire batch back when that happens,
    // which prevents a zero-row ownership update from leaving the claim
    // approved. Its successful no-op update also preserves changes() = 1 for
    // the final rejection statement.
    let results;
    try {
      const claimStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE developer_claims
              SET status = 'approved', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'pending'
                AND EXISTS (
                  SELECT 1 FROM developers d
                  WHERE d.id = developer_claims.developer_id
                    AND d.owner_user_id IS NULL
                )
                AND NOT EXISTS (
                  SELECT 1 FROM developers owned
                  WHERE owned.owner_user_id = developer_claims.claimant_id
                )
                AND EXISTS (
                  SELECT 1 FROM users
                  WHERE users.id = ? AND users.deleted_at IS NULL
                )`,
        params: [reviewerId, claimId, reviewerId]
      });
      const developerStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE developers
              SET owner_user_id = ?,
                  ownership_epoch = ownership_epoch + 1,
                  content_revision = content_revision + 1,
                  approved_at = NULL, approved_revision = NULL, approved_by = NULL,
                  url_check_cooldown_until = NULL,
                  github_org_verified = ?, github_verification_note = ?,
                  github_verified_at = ?, updated_at = CURRENT_TIMESTAMP
              WHERE changes() = 1 AND id = ? AND owner_user_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM developers WHERE owner_user_id = ?)`,
        params: [
          claim.claimant_id,
          claim.github_org_verified === undefined
            ? null
            : claim.github_org_verified
              ? 1
              : 0,
          claim.github_verification_note ?? null,
          claim.github_org_verified === undefined ? null : claim.created_at,
          claim.developer_id,
          claim.claimant_id
        ]
      });
      const assertTransferStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE developers
              SET ownership_epoch = CASE WHEN changes() = 1 THEN ownership_epoch ELSE 0 END
              WHERE id = ?`,
        params: [claim.developer_id]
      });
      const rejectOthersStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE developer_claims
              SET status = 'rejected', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP,
                  review_note = 'Another claim on this profile was approved'
              WHERE changes() = 1 AND developer_id = ? AND status = 'pending' AND id != ?`,
        params: [reviewerId, claim.developer_id, claimId]
      });

      results = await this.db.$client.batch([
        claimStmt,
        developerStmt,
        assertTransferStmt,
        rejectOthersStmt
      ]);
    } catch (error) {
      if (isOwnershipEpochRollback(error)) {
        return this.claimApprovalOutcome(
          await this.explainClaimApprovalNoOp(claim),
          claim
        );
      }
      if (isDeveloperOwnerConflict(error)) {
        return {
          data: null,
          error: {
            message: "The claimant already owns a different developer profile",
            code: "CONFLICT"
          }
        };
      }
      return databaseError("approveClaim", error);
    }

    const [claimResult] = results;
    if (!claimResult.meta?.changes) {
      // Diagnose only after the guarded transaction. These reads improve the
      // response without participating in (or weakening) its race safety.
      return this.claimApprovalOutcome(
        await this.explainClaimApprovalNoOp(claim),
        claim
      );
    }

    // The claim snapshot rides along so the route doesn't need its own
    // pre-approval read to build the notification (after the transfer the
    // profile row no longer records who the claimant was).
    const profile = await new DeveloperProfilesDatabase(this.db).getById(
      claim.developer_id
    );
    return this.claimApprovalOutcome(profile, claim);
  }

  // Adapts the profile-shaped outcomes of the approval path to the
  // claim-carrying shape approveClaim returns.
  private claimApprovalOutcome(
    profileResult: DatabaseResult<DeveloperProfile>,
    claim: DeveloperClaim
  ): DatabaseResult<{ profile: DeveloperProfile; claim: DeveloperClaim }> {
    if (profileResult.error || !profileResult.data) {
      return { data: null, error: profileResult.error };
    }
    return { data: { profile: profileResult.data, claim }, error: null };
  }

  async rejectClaim(
    claimId: string,
    reviewerId: string,
    reviewNote: string
  ): Promise<DatabaseResult<DeveloperClaim>> {
    let result;
    try {
      result = await this.db
        .update(developerClaims)
        .set({
          status: "rejected",
          reviewerId,
          reviewNote,
          reviewedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(developerClaims.id, claimId),
            eq(developerClaims.status, "pending"),
            sql`EXISTS (
              SELECT 1 FROM ${users}
              WHERE ${users.id} = ${reviewerId} AND ${users.deletedAt} IS NULL
            )`
          )
        );
    } catch (error) {
      return databaseError("rejectClaim", error);
    }

    if (!result.meta?.changes) {
      return {
        data: null,
        error: {
          message: `Cannot find pending claim by id: ${claimId}`,
          code: "NOT_FOUND"
        }
      };
    }

    return this.getClaimById(claimId);
  }
}

interface ClaimCursor {
  k1: string;
  k2: string;
  s: "mine" | "pending";
}

function encodeClaimCursor(
  k1: string,
  k2: string,
  s: "mine" | "pending"
): string {
  return encode({ k1, k2, s });
}

function isClaimCursor(
  parsed: Record<string, unknown>
): parsed is ClaimCursor & Record<string, unknown> {
  return (
    typeof parsed.k1 === "string" &&
    typeof parsed.k2 === "string" &&
    (parsed.s === "mine" || parsed.s === "pending")
  );
}

function decodeClaimCursor(cursor: string): ClaimCursor | null {
  return decode(cursor, isClaimCursor);
}
