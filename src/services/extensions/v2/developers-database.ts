import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { DatabaseError, DatabaseResult } from "../../../lib/interfaces";
import { ExtensionsDb } from "../../../lib/db";
import {
  developers,
  developerHistory,
  developerTransfers,
  developerClaims,
  extensions,
  extensionSubmissions
} from "./db/schema";
import { users as externalUsers } from "./db/external-tables";
import { databaseError, errorMessageChain } from "./errors";
import { toD1Statement } from "./d1-batch";
import {
  checkGithubEntity,
  matchesClaimant,
  urlMatchesGithubBlog
} from "./github-verification";
import {
  Developer,
  DeveloperClaim,
  DeveloperHistoryEntry,
  DeveloperProfile,
  DeveloperTransfer,
  PendingDeveloperClaim
} from "./interfaces";
import { UsersDatabase } from "./users-database";

// Matches the SQLite/D1 message for the idx_developers_owner_unique
// violation, which is how a lost race between two concurrent first-time PUT
// /developers/me requests (same caller, different ids) surfaces.
function isOwnerConflict(error: unknown): boolean {
  return /UNIQUE constraint failed.*owner_user_id/i.test(
    errorMessageChain(error)
  );
}

// Matches the SQLite/D1 message for the idx_developer_claims_pending_unique
// violation, which is how a duplicate claim() call while one is already
// pending surfaces.
function isPendingClaimConflict(error: unknown): boolean {
  return /UNIQUE constraint failed.*developer_claims/i.test(
    errorMessageChain(error)
  );
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// SQLite's CURRENT_TIMESTAMP renders as "YYYY-MM-DD HH:MM:SS" (space
// separator, no milliseconds, no "Z"). expires_at is compared against it
// directly in SQL (`expires_at > CURRENT_TIMESTAMP`), which is a plain
// string comparison — a JS `Date#toISOString()` value ("...THH:MM:SS.sssZ")
// would sort wrong once the two share the same calendar day, since 'T'
// (0x54) always outranks ' ' (0x20) at that position regardless of the
// actual time that follows. Matching the format keeps the comparison correct.
function toSqliteDatetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

type DeveloperRow = typeof developers.$inferSelect;
type ClaimRow = typeof developerClaims.$inferSelect;

function parseDeveloperRow(row: DeveloperRow): DeveloperProfile {
  return {
    id: row.id,
    type: row.type as DeveloperProfile["type"],
    name: row.name,
    URL: row.url ?? undefined,
    avatar_url: row.avatarUrl ?? undefined,
    contact_email: row.contactEmail ?? undefined,
    approved:
      row.approvedAt !== null &&
      row.approvedAt !== undefined &&
      (row.approvedRevision == null ||
        Number(row.approvedRevision) === Number(row.contentRevision ?? 1)),
    content_revision: Number(row.contentRevision ?? 1),
    github_org_verified:
      row.githubOrgVerified === null || row.githubOrgVerified === undefined
        ? undefined
        : row.githubOrgVerified === 1,
    github_verification_note: row.githubVerificationNote ?? undefined,
    github_verified_at: row.githubVerifiedAt ?? undefined,
    github_url_verified: row.githubUrlVerified === 1 ? true : undefined
  };
}

// Used by listAll/listUnapproved, whose queries left-join externalUsers on
// developers.owner_user_id to save the moderator a lookup per row (see
// PendingDeveloperClaim's claimant_name/claimant_github_login for the same
// pattern on the claims queue).
function parseDeveloperRowWithOwner(row: {
  developer: DeveloperRow;
  ownerName: string | null;
  ownerGithubLogin: string | null;
}): DeveloperProfile {
  return {
    ...parseDeveloperRow(row.developer),
    unclaimed: row.developer.ownerUserId === null,
    owner_name: row.ownerName,
    owner_github_login: row.ownerGithubLogin
  };
}

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
    github_org_verified:
      row.githubOrgVerified === null || row.githubOrgVerified === undefined
        ? undefined
        : row.githubOrgVerified === 1,
    github_verification_note: row.githubVerificationNote ?? undefined
  };
}

export class DevelopersDatabase {
  constructor(private db: ExtensionsDb) {}

  // githubToken — see the comment on verifyGithubOwnership(). Only consulted
  // when creating a brand-new profile (developer.id is immutable once
  // owned, so an update can't need re-verifying); guards against squatting
  // on an id that matches a real GitHub org/user the caller doesn't control,
  // the one gap claim() alone can't close since it only ever applies to
  // rows that already exist unowned.
  async upsertOwn(
    userId: string,
    developer: Developer,
    githubToken?: string
  ): Promise<DatabaseResult<DeveloperProfile>> {
    try {
      const [existingOwn] = await this.db
        .select()
        .from(developers)
        .where(eq(developers.ownerUserId, userId));

      const [existingById] = await this.db
        .select()
        .from(developers)
        .where(eq(developers.id, developer.id));

      let githubOrgVerified: number | null = null;
      let githubUrlVerified: number | null = null;
      let githubVerificationNote: string | null = null;

      let mainStmt;
      if (!existingOwn) {
        if (existingById) {
          // Distinct from the generic CONFLICT used elsewhere in this file —
          // consumers (the extensions repo's create-profile form) need to
          // reliably detect this specific case to point the user at the
          // claim flow, which a shared, message-string-matched code can't do.
          return {
            data: null,
            error: {
              message: "Developer id already exists",
              code: "DEVELOPER_ID_TAKEN"
            }
          };
        }

        const check = await this.verifyGithubOwnership(
          developer.id,
          developer.type,
          userId,
          githubToken,
          developer.URL
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
                "This id matches a real GitHub organization or username that isn't linked to your account, so it can't be used automatically. Make sure you're signed in with the right GitHub account, or choose a different id."
            }
          };
        }

        githubOrgVerified = check.githubOrgVerified;
        githubUrlVerified = check.githubUrlVerified;
        githubVerificationNote = check.note;

        mainStmt = this.db.insert(developers).values({
          id: developer.id,
          type: developer.type,
          name: developer.name,
          url: developer.URL ?? null,
          avatarUrl: developer.avatar_url ?? null,
          contactEmail: developer.contact_email ?? null,
          ownerUserId: userId,
          approvedAt: null,
          githubOrgVerified,
          githubUrlVerified,
          githubVerificationNote,
          githubVerifiedAt: githubOrgVerified !== null ? sql`CURRENT_TIMESTAMP` : null,
          createdAt: sql`CURRENT_TIMESTAMP`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        });
      } else {
        if (developer.id !== existingOwn.id) {
          return {
            data: null,
            error: {
              message: "Developer id cannot be changed",
              code: "CONFLICT"
            }
          };
        }

        // approved_at is normally cleared here, even if nothing meaningful
        // changed — the reviewed content just got overwritten, so the old
        // approval no longer applies. Not worth diffing old vs. new field
        // values for that. The one exception: a profile that's currently
        // GitHub org/user verified keeps its approval across edits — that
        // verification is an independently-computed identity signal (this
        // write never touches githubOrgVerified, except when the id's type
        // changes below) strong enough on its own that re-queuing for
        // manual review on every edit isn't worth the moderator load.
        // approvedRevision is bumped in lockstep with contentRevision in
        // that branch so the existing approval keeps matching (see
        // parseDeveloperRow) instead of silently going stale.
        //
        // A type change invalidates the existing GitHub verification
        // outright — matchesClaimant() compares differently per type (org
        // membership vs. username), so a signal computed for the old type
        // says nothing about the new one. Falls back to approval clearing
        // and manual review, same as any other unverified edit.
        const typeChanged = developer.type !== existingOwn.type;
        // A URL change invalidates only the URL signal, not identity —
        // github_url_verified describes whether *this* URL matches GitHub's
        // on-file website, so a stale URL can't still be "verified" once
        // it's no longer the URL being served.
        const urlChanged = (developer.URL ?? null) !== existingOwn.url;
        const keepsApproval = !typeChanged && existingOwn.githubOrgVerified === 1;

        mainStmt = this.db
          .update(developers)
          .set({
            type: developer.type,
            name: developer.name,
            url: developer.URL ?? null,
            avatarUrl: developer.avatar_url ?? null,
            contactEmail: developer.contact_email ?? null,
            contentRevision: sql`content_revision + 1`,
            ...(keepsApproval
              ? { approvedRevision: sql`content_revision + 1` }
              : { approvedAt: null, approvedRevision: null, approvedBy: null }),
            ...(typeChanged
              ? {
                  githubOrgVerified: null,
                  githubVerificationNote: null,
                  githubVerifiedAt: null,
                  githubUrlVerified: null
                }
              : urlChanged
                ? { githubUrlVerified: null }
                : {}),
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(
            and(
              eq(developers.id, developer.id),
              eq(developers.ownerUserId, userId)
            )
          );
      }

      // Batched via the raw D1 client ($client - see toD1Statement's
      // comment): drizzle-orm 0.45.2's D1 batch() throws
      // "Cannot read properties of undefined (reading 'bind')" for any
      // db.run(sql\`...\`) item that has bound params (confirmed via an
      // isolated repro against real D1 - its prepared-query wrapper for
      // raw sql lacks the .stmt property batch() unconditionally reads).
      // Gated on changes() = 1 (the immediately preceding batch statement)
      // rather than a query-builder insert, since there's no FROM table to
      // build this against - it's a conditional literal-values insert.
      const historyStmt = toD1Statement(this.db.$client, {
        sql: `INSERT INTO developer_history (id, developer_id, type, name, url, changed_by, changed_at)
              SELECT ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
              WHERE changes() = 1`,
        params: [
          crypto.randomUUID(),
          developer.id,
          developer.type,
          developer.name,
          developer.URL ?? null,
          userId
        ]
      });

      let results;
      try {
        results = await this.db.$client.batch([
          toD1Statement(this.db.$client, mainStmt.toSQL()),
          historyStmt
        ]);
      } catch (error) {
        if (isOwnerConflict(error)) {
          return {
            data: null,
            error: {
              message: "You already have a developer profile",
              code: "CONFLICT"
            }
          };
        }
        return databaseError("upsertOwn", error);
      }

      if (!results[0]?.meta?.changes) {
        return {
          data: null,
          error: {
            message: "Developer ownership changed while updating the profile",
            code: "CONFLICT"
          }
        };
      }

      const [current] = await this.db
        .select()
        .from(developers)
        .where(
          and(
            eq(developers.id, developer.id),
            eq(developers.ownerUserId, userId)
          )
        );
      if (!current) {
        return {
          data: null,
          error: {
            message: "Developer ownership changed while updating the profile",
            code: "CONFLICT"
          }
        };
      }
      return { data: parseDeveloperRow(current), error: null };
    } catch (error) {
      return databaseError("upsertOwn", error);
    }
  }

  // Diagnoses why the guarded delete in deleteOwn() below affected zero
  // rows: distinguishes no-longer-owned/nonexistent from the two blocking
  // conditions, without reopening the race the guard already closed.
  private async deletionBlockedError(
    developerId: string,
    userId: string
  ): Promise<{ code: "NOT_FOUND" | "CONFLICT"; message: string }> {
    const [developer] = await this.db
      .select({ ownerUserId: developers.ownerUserId })
      .from(developers)
      .where(eq(developers.id, developerId));

    if (!developer || developer.ownerUserId !== userId) {
      return { code: "NOT_FOUND", message: "Developer not found" };
    }

    const [extensionCount] = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(extensions)
      .where(eq(extensions.authorId, developerId));
    const extensionsCount = extensionCount?.count ?? 0;
    if (extensionsCount > 0) {
      return {
        code: "CONFLICT",
        message: `You have ${extensionsCount} published extension(s) under this profile. Transfer ownership or remove them before deleting it.`
      };
    }

    const [pendingCount] = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(extensionSubmissions)
      .where(
        and(
          eq(extensionSubmissions.developerId, developerId),
          eq(extensionSubmissions.status, "pending")
        )
      );
    if ((pendingCount?.count ?? 0) > 0) {
      return {
        code: "CONFLICT",
        message:
          "You have a pending submission under review. Wait for it to be resolved before deleting your profile."
      };
    }

    // The guard failed but a fresh look finds nothing wrong — whatever
    // blocked it (someone else's transfer/claim landing, a submission
    // that has since been resolved) has already cleared. Ask the caller
    // to retry rather than guessing at a reason that's no longer true.
    return {
      code: "CONFLICT",
      message:
        "Your profile changed while processing this request. Please try again."
    };
  }

  // Permanently removes the caller's own developer profile, for a
  // privacy-focused account-deletion flow. Refuses while anything would be
  // left dangling in a way that isn't just historical record-keeping:
  // published extensions (someone still needs to own them) and pending
  // submissions (nothing left to approve/reject against once the named
  // developer is gone). developer_history is deliberately left alone —
  // it's an append-only audit log, moderator-only, never rendered publicly,
  // and 0009_drop_developer_history_fk.sql dropped its FK to developers(id)
  // specifically so a deleted developer's history rows can outlive it.
  async deleteOwn(
    userId: string
  ): Promise<DatabaseResult<{ id: string; deleted: true }>> {
    try {
      const [developer] = await this.db
        .select({ id: developers.id })
        .from(developers)
        .where(eq(developers.ownerUserId, userId));

      if (!developer) {
        return {
          data: null,
          error: { message: "Developer not found", code: "NOT_FOUND" }
        };
      }

      // Every statement re-checks eligibility (still owned by this caller,
      // no published extensions, no pending submission) at the moment it
      // runs, rather than trusting the SELECT above: ownership can move
      // (an accepted transfer/claim) and a new extension or pending
      // submission can appear between that check and this write, and this
      // delete is the caller's only authorization check. The same guard is
      // repeated on all three statements — not just the last — so they're
      // all-or-nothing: if it fails, nothing here is touched, instead of
      // transfers/claims being deleted out from under a profile whose own
      // deletion then gets blocked. Kept as raw sql via $client (see
      // toD1Statement): the correlated EXISTS subqueries reference the
      // outer statement's own table name, which the query builder can't
      // express, and this batch needs the raw-D1 escape hatch regardless
      // (see upsertOwn's historyStmt comment).
      const deleteTransfersStmt = toD1Statement(this.db.$client, {
        sql: `DELETE FROM developer_transfers
              WHERE developer_id = ?
                AND EXISTS (
                  SELECT 1 FROM developers
                  WHERE developers.id = developer_transfers.developer_id
                    AND developers.owner_user_id = ?
                    AND NOT EXISTS (SELECT 1 FROM extensions WHERE extensions.author_id = developers.id)
                    AND NOT EXISTS (
                      SELECT 1 FROM extension_submissions
                      WHERE extension_submissions.developer_id = developers.id
                        AND extension_submissions.status = 'pending'
                    )
                )`,
        params: [developer.id, userId]
      });

      const deleteClaimsStmt = toD1Statement(this.db.$client, {
        sql: `DELETE FROM developer_claims
              WHERE developer_id = ?
                AND EXISTS (
                  SELECT 1 FROM developers
                  WHERE developers.id = developer_claims.developer_id
                    AND developers.owner_user_id = ?
                    AND NOT EXISTS (SELECT 1 FROM extensions WHERE extensions.author_id = developers.id)
                    AND NOT EXISTS (
                      SELECT 1 FROM extension_submissions
                      WHERE extension_submissions.developer_id = developers.id
                        AND extension_submissions.status = 'pending'
                    )
                )`,
        params: [developer.id, userId]
      });

      const deleteDeveloperStmt = toD1Statement(this.db.$client, {
        sql: `DELETE FROM developers
              WHERE id = ?
                AND owner_user_id = ?
                AND NOT EXISTS (SELECT 1 FROM extensions WHERE extensions.author_id = developers.id)
                AND NOT EXISTS (
                  SELECT 1 FROM extension_submissions
                  WHERE extension_submissions.developer_id = developers.id
                    AND extension_submissions.status = 'pending'
                )`,
        params: [developer.id, userId]
      });

      let results;
      try {
        results = await this.db.$client.batch([
          deleteTransfersStmt,
          deleteClaimsStmt,
          deleteDeveloperStmt
        ]);
      } catch (error) {
        return databaseError("deleteOwn", error);
      }

      const [, , developerResult] = results;
      if (!developerResult.meta?.changes) {
        return {
          data: null,
          error: await this.deletionBlockedError(developer.id, userId)
        };
      }

      return { data: { id: developer.id, deleted: true }, error: null };
    } catch (error) {
      return databaseError("deleteOwn", error);
    }
  }

  async getById(id: string): Promise<DatabaseResult<DeveloperProfile>> {
    try {
      const [row] = await this.db
        .select()
        .from(developers)
        .where(eq(developers.id, id));
      if (!row) {
        return {
          data: null,
          error: {
            message: `Cannot find developer by id: ${id}`,
            code: "NOT_FOUND"
          }
        };
      }
      return { data: parseDeveloperRow(row), error: null };
    } catch (error) {
      return databaseError("getById", error);
    }
  }

  async listAll(): Promise<DatabaseResult<DeveloperProfile[]>> {
    let rows;
    try {
      rows = await this.db
        .select({
          developer: developers,
          ownerName: externalUsers.name,
          ownerGithubLogin: externalUsers.githubLogin
        })
        .from(developers)
        .leftJoin(externalUsers, eq(externalUsers.id, developers.ownerUserId))
        .orderBy(asc(developers.name));
    } catch (error) {
      return databaseError("listAll", error);
    }

    return { data: rows.map(parseDeveloperRowWithOwner), error: null };
  }

  async listUnapproved(): Promise<DatabaseResult<DeveloperProfile[]>> {
    let rows;
    try {
      rows = await this.db
        .select({
          developer: developers,
          ownerName: externalUsers.name,
          ownerGithubLogin: externalUsers.githubLogin
        })
        .from(developers)
        .leftJoin(externalUsers, eq(externalUsers.id, developers.ownerUserId))
        .where(isNull(developers.approvedAt))
        .orderBy(asc(developers.createdAt));
    } catch (error) {
      return databaseError("listUnapproved", error);
    }

    return { data: rows.map(parseDeveloperRowWithOwner), error: null };
  }

  async approve(
    id: string,
    expectedRevision: number,
    reviewerId: string
  ): Promise<DatabaseResult<{ id: string; approved: true }>> {
    let result;
    try {
      result = await this.db
        .update(developers)
        .set({
          approvedAt: sql`CURRENT_TIMESTAMP`,
          approvedRevision: sql`content_revision`,
          approvedBy: reviewerId
        })
        .where(
          and(
            eq(developers.id, id),
            eq(developers.contentRevision, expectedRevision)
          )
        );
    } catch (error) {
      return databaseError("approve", error);
    }

    if (!result.meta?.changes) {
      const existing = await this.getById(id);
      return existing.error
        ? {
            data: null,
            error: {
              message: `Cannot find developer by id: ${id}`,
              code: "NOT_FOUND"
            }
          }
        : {
            data: null,
            error: {
              message:
                "Developer profile changed after it was reviewed; reload it and approve the current revision",
              code: "CONFLICT"
            }
          };
    }

    return { data: { id, approved: true }, error: null };
  }

  async listHistory(
    developerId: string
  ): Promise<DatabaseResult<DeveloperHistoryEntry[]>> {
    let rows;
    try {
      rows = await this.db
        .select({
          developerId: developerHistory.developerId,
          type: developerHistory.type,
          name: developerHistory.name,
          url: developerHistory.url,
          changedBy: developerHistory.changedBy,
          changedByName: externalUsers.name,
          changedAt: developerHistory.changedAt
        })
        .from(developerHistory)
        .leftJoin(externalUsers, eq(externalUsers.id, developerHistory.changedBy))
        .where(eq(developerHistory.developerId, developerId))
        // CURRENT_TIMESTAMP has only second resolution, so two writes in
        // the same second tie on changed_at; rowid (insertion order,
        // implicit - not a declared schema column) breaks the tie so
        // "newest first" is never ambiguous.
        .orderBy(
          desc(developerHistory.changedAt),
          sql`"developer_history".rowid DESC`
        );
    } catch (error) {
      return databaseError("listHistory", error);
    }

    return {
      data: rows.map((row) => ({
        developer_id: row.developerId,
        type: row.type as DeveloperHistoryEntry["type"],
        name: row.name,
        URL: row.url ?? undefined,
        changed_by: row.changedBy,
        changed_by_name: row.changedByName,
        changed_at: row.changedAt
      })),
      error: null
    };
  }

  // Shared by initiateTransfer/revokeTransfer: both are owner-only actions on
  // an existing developer, so both need the same NOT_FOUND/FORBIDDEN check.
  private async checkOwnership(
    developerId: string,
    userId: string
  ): Promise<{ code: "NOT_FOUND" | "FORBIDDEN"; message: string } | null> {
    const [owner] = await this.db
      .select({ ownerUserId: developers.ownerUserId })
      .from(developers)
      .where(eq(developers.id, developerId));

    if (!owner) {
      return { code: "NOT_FOUND", message: "Developer not found" };
    }
    if (owner.ownerUserId !== userId) {
      return { code: "FORBIDDEN", message: "You don't own this profile" };
    }
    return null;
  }

  async initiateTransfer(
    developerId: string,
    userId: string
  ): Promise<DatabaseResult<DeveloperTransfer>> {
    try {
      const token =
        crypto.randomUUID().replace(/-/g, "") +
        crypto.randomUUID().replace(/-/g, "");
      const tokenHash = await sha256Hex(token);
      const expiresAt = toSqliteDatetime(new Date(Date.now() + 60 * 60 * 1000));

      // Both writes are conditioned on current ownership in the same
      // statement, rather than a separate SELECT beforehand — a caller who
      // loses ownership between an up-front check and the write could
      // otherwise still slip the write through. Superseding any existing
      // pending transfer (rather than stacking up) keeps
      // idx_developer_transfers_pending satisfied without a separate cleanup
      // pass. Kept as raw sql via $client (see toD1Statement): the EXISTS
      // subqueries are correlated against the outer table's own name, and
      // this batch needs the raw-D1 escape hatch regardless (see
      // upsertOwn's historyStmt comment).
      const revokeStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE developer_transfers SET revoked_at = CURRENT_TIMESTAMP
              WHERE developer_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
                AND EXISTS (SELECT 1 FROM developers WHERE developers.id = developer_transfers.developer_id AND developers.owner_user_id = ?)`,
        params: [developerId, userId]
      });
      const insertStmt = toD1Statement(this.db.$client, {
        sql: `INSERT INTO developer_transfers (id, developer_id, token_hash, created_by, expires_at)
              SELECT ?, ?, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM developers WHERE id = ? AND owner_user_id = ?)`,
        params: [
          crypto.randomUUID(),
          developerId,
          tokenHash,
          userId,
          expiresAt,
          developerId,
          userId
        ]
      });

      const results = await this.db.$client.batch([revokeStmt, insertStmt]);

      // The INSERT only writes a row when the ownership guard above passes,
      // so zero rows written means the caller doesn't currently own this
      // developer — a follow-up read distinguishes NOT_FOUND from FORBIDDEN
      // for the response without reopening the race the guard closes.
      if (!results[1]?.meta?.changes) {
        const ownershipError = await this.checkOwnership(developerId, userId);
        return {
          data: null,
          error: ownershipError ?? {
            code: "FORBIDDEN",
            message: "You don't own this profile"
          }
        };
      }

      return { data: { token, expires_at: expiresAt }, error: null };
    } catch (error) {
      return databaseError("initiateTransfer", error);
    }
  }

  async revokeTransfer(
    developerId: string,
    userId: string
  ): Promise<DatabaseResult<{ id: string; revoked: true }>> {
    try {
      const result = await this.db.run(sql`
        UPDATE ${developerTransfers} SET revoked_at = CURRENT_TIMESTAMP
           WHERE developer_id = ${developerId} AND accepted_at IS NULL AND revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM ${developers} WHERE developers.id = developer_transfers.developer_id AND developers.owner_user_id = ${userId})
      `);

      // Zero rows changed is ambiguous by itself (no pending transfer vs.
      // not the owner vs. no such developer), since the ownership guard is
      // folded into the write above rather than checked beforehand. A
      // follow-up read-only check distinguishes them for the response
      // without reopening the race that guard closes.
      if (!result.meta?.changes) {
        const ownershipError = await this.checkOwnership(developerId, userId);
        if (ownershipError) {
          return { data: null, error: ownershipError };
        }
      }

      return { data: { id: developerId, revoked: true }, error: null };
    } catch (error) {
      return databaseError("revokeTransfer", error);
    }
  }

  async acceptTransfer(
    token: string,
    userId: string
  ): Promise<DatabaseResult<DeveloperProfile>> {
    try {
      const tokenHash = await sha256Hex(token);

      // Claim the transfer and move ownership in the same atomic batch,
      // rather than as two separate writes. Splitting them would leave a
      // window, after the claim commits but before ownership actually
      // moves, where the *former* owner's initiateTransfer call would still
      // see itself as the current owner (per the developers row) and could
      // mint a fresh, valid link for a profile that's already mid-handoff.
      // It would also mean a failure on the ownership write alone (e.g. the
      // recipient racing to create another profile) permanently burns the
      // token without ever transferring ownership, with no way to retry.
      // Batching both as one D1 transaction makes them succeed or fail as a
      // unit. The `changes() = 1` guard on the second statement is load-
      // bearing, not redundant with the subquery: accepted_by/accepted_at
      // are a permanent historical record once a token is claimed, so the
      // subquery alone would match a *previously* accepted token forever,
      // letting a replay of an old, already-used link silently reassign
      // ownership again (even to a profile since handed off to someone
      // else) despite the claim itself changing zero rows.
      // `changes()` reports the row count from the immediately preceding
      // statement on this same connection, so it's only 1 when *this*
      // batch's claim just fired — proving the update below is reacting to
      // a fresh claim, not replaying an old one.
      //
      // The claim's NOT EXISTS guard folds the self-accept case (accepting
      // user already owns *this* developer) and the already-owns-a-
      // different-profile case into the same atomic decision, so the token
      // is never consumed unless the accepting user is actually eligible. A
      // plain check-then-act (SELECT the row, decide, then write) would let
      // two concurrent accepts both read it as valid before either one
      // wrote to it, making the token usable more than once.
      // Kept as raw sql via $client (see toD1Statement): correlated
      // subqueries plus the changes()=1 gates need the raw-D1 escape hatch
      // (see upsertOwn's historyStmt comment).
      const claimStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE developer_transfers SET accepted_at = CURRENT_TIMESTAMP, accepted_by = ?
              WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
                AND NOT EXISTS (SELECT 1 FROM developers WHERE owner_user_id = ?)`,
        params: [userId, tokenHash, userId]
      });
      const updateDeveloperStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE developers
              SET owner_user_id = ?,
                  ownership_epoch = ownership_epoch + 1,
                  content_revision = content_revision + 1,
                  approved_at = NULL, approved_revision = NULL, approved_by = NULL,
                  updated_at = CURRENT_TIMESTAMP
              WHERE changes() = 1
                AND id = (
                  SELECT developer_id FROM developer_transfers
                  WHERE token_hash = ? AND accepted_by = ? AND accepted_at IS NOT NULL
                )`,
        params: [userId, tokenHash, userId]
      });

      const rejectPendingStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE extension_submissions
              SET status = 'rejected',
                  review_note = 'Ownership changed before review',
                  reviewed_at = CURRENT_TIMESTAMP
              WHERE changes() = 1
                AND developer_id = (
                  SELECT developer_id FROM developer_transfers
                  WHERE token_hash = ? AND accepted_by = ? AND accepted_at IS NOT NULL
                )
                AND status = 'pending'`,
        params: [tokenHash, userId]
      });

      let results;
      try {
        results = await this.db.$client.batch([
          claimStmt,
          updateDeveloperStmt,
          rejectPendingStmt
        ]);
      } catch (error) {
        if (isOwnerConflict(error)) {
          return {
            data: null,
            error: {
              code: "CONFLICT",
              message:
                "You already have a developer profile — remove or transfer it before accepting a new one"
            }
          };
        }
        return databaseError("acceptTransfer", error);
      }

      const [claim] = results;
      if (!claim.meta?.changes) {
        // The claim can fail either because the token itself is bad (used,
        // revoked, expired, unknown) or because it's still valid but the
        // ownership guard rejected it — check which, for an accurate error.
        const [stillPending] = await this.db
          .select({ one: sql`1` })
          .from(developerTransfers)
          .where(
            and(
              eq(developerTransfers.tokenHash, tokenHash),
              isNull(developerTransfers.acceptedAt),
              isNull(developerTransfers.revokedAt),
              sql`${developerTransfers.expiresAt} > CURRENT_TIMESTAMP`
            )
          );

        if (stillPending) {
          return {
            data: null,
            error: {
              code: "CONFLICT",
              message:
                "You already have a developer profile — remove or transfer it before accepting a new one"
            }
          };
        }
        return {
          data: null,
          error: {
            code: "NOT_FOUND",
            message: "This transfer link is invalid, used, or expired"
          }
        };
      }

      const [transfer] = await this.db
        .select({ developerId: developerTransfers.developerId })
        .from(developerTransfers)
        .where(eq(developerTransfers.tokenHash, tokenHash));
      if (!transfer) {
        return databaseError(
          "acceptTransfer",
          new Error("Claimed transfer row not found")
        );
      }

      return this.getById(transfer.developerId);
    } catch (error) {
      return databaseError("acceptTransfer", error);
    }
  }

  private async getClaimById(
    id: string
  ): Promise<DatabaseResult<DeveloperClaim>> {
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

  // Shared by claim/approveClaim once a developer/eligibility-guarded write
  // affects zero rows: distinguishes "no such developer" from the two
  // possible ownership conflicts for an accurate response, without
  // reopening the race the guarded write already closed.
  private async claimIneligibilityError(
    developerId: string
  ): Promise<{ code: "NOT_FOUND" | "CONFLICT"; message: string }> {
    const [developer] = await this.db
      .select({ ownerUserId: developers.ownerUserId })
      .from(developers)
      .where(eq(developers.id, developerId));
    if (!developer) {
      return { code: "NOT_FOUND", message: "Developer not found" };
    }
    if (developer.ownerUserId !== null) {
      return { code: "CONFLICT", message: "This profile is already owned" };
    }
    return {
      code: "CONFLICT",
      message: "You already have a developer profile"
    };
  }

  // githubToken authenticates the GitHub entity-existence lookup only (a
  // service-level credential, raises the public rate limit) — it is never
  // the claimant's own token, which never leaves the auth service. Shared by
  // claim() and upsertOwn(): both need the same question answered — does a
  // real GitHub org/user exist for this id, and if so, does the caller's own
  // linked GitHub identity match it? A positive mismatch is the only outcome
  // that ever blocks; no real GitHub entity for this id, or the caller
  // having no linked GitHub identity yet, both fall back to unverified
  // (manual moderator review), never to a block.
  // publisherUrl — only ever passed by upsertOwn's create path, which is the
  // one place a new Publisher URL is actually being submitted alongside
  // identity verification; claim() has no URL of its own to cross-check
  // (the developer row it's claiming already exists). Drives
  // githubUrlVerified only — a non-matching or unset GitHub "website" field
  // never blocks or un-verifies identity, since it's optional and often
  // stale, unlike the identity check above.
  private async verifyGithubOwnership(
    developerId: string,
    developerType: Developer["type"],
    callerId: string,
    githubToken?: string,
    publisherUrl?: string
  ): Promise<
    | { mismatch: true }
    | {
        mismatch: false;
        githubOrgVerified: number | null;
        githubUrlVerified: number | null;
        note: string | null;
      }
    | { error: DatabaseError }
  > {
    const githubEntity = await checkGithubEntity(developerId, githubToken ?? "");

    if (githubEntity === null) {
      // Also covers a failed lookup (rate limit, network, auth error) —
      // checkGithubEntity can't tell "confirmed absent" from "couldn't
      // check", so the note can't claim to know no matching entity exists.
      return {
        mismatch: false,
        githubOrgVerified: null,
        githubUrlVerified: null,
        note: "GitHub entity was not verified automatically — reviewed manually."
      };
    }

    // A real GitHub entity exists for this id, just under the other type
    // (e.g. a real org submitted as a "user") — this is a confirmed
    // disagreement with GitHub, not an unknown, so it must block rather than
    // fall back to unverified. Otherwise a caller could take a real org/user's
    // id unverified simply by submitting the wrong type for it.
    if (githubEntity.type !== developerType) {
      return { mismatch: true };
    }

    const identity = await new UsersDatabase(this.db).getGithubIdentity(
      callerId
    );
    // A real DB/schema failure here is not the same as "caller has no linked
    // GitHub identity" — swallowing it would silently let creation/claiming
    // proceed unverified during an outage instead of surfacing the error.
    if (identity.error || !identity.data) {
      return {
        error: identity.error ?? {
          message: "Failed to load caller's GitHub identity",
          code: "DATABASE_ERROR"
        }
      };
    }
    const callerIdentity = identity.data;

    if (!callerIdentity.githubLogin) {
      return {
        mismatch: false,
        githubOrgVerified: null,
        githubUrlVerified: null,
        note: "Caller has no linked GitHub identity yet — reviewed manually."
      };
    }

    if (matchesClaimant(developerType, developerId, callerIdentity)) {
      return {
        mismatch: false,
        githubOrgVerified: 1,
        githubUrlVerified: urlMatchesGithubBlog(publisherUrl, githubEntity.blog)
          ? 1
          : null,
        note: "Verified: caller's linked GitHub identity matches."
      };
    }

    return { mismatch: true };
  }

  // Re-runs the same identity match verifyGithubOwnership() does for a
  // brand-new claim/creation, but for a profile the caller already owns —
  // no GitHub API call needed. checkGithubEntityType() (the GitHub call
  // verifyGithubOwnership() makes) only exists to confirm a *new* id isn't
  // squatting on a real GitHub org/user; that doesn't apply once ownership
  // already exists, so this only re-derives the match from the caller's
  // own already-synced github_login/github_orgs. Called opportunistically
  // on every login for a developer-owning user, and by the owner's own
  // "Re-verify" action — both share this one method.
  // checkUrl/githubToken — only set by the owner's own manual "Re-verify"
  // button, never by the opportunistic per-login call in extensions'
  // auth/callback.ts. Re-checking Publisher URL against GitHub's on-file
  // website needs a fresh GitHub API call (unlike the identity match below),
  // so it stays opt-in to keep the automatic login path GitHub-API-free.
  async reverifyOwn(
    userId: string,
    checkUrl?: boolean,
    githubToken?: string
  ): Promise<DatabaseResult<DeveloperProfile>> {
    try {
      const [row] = await this.db
        .select({ id: developers.id, type: developers.type, url: developers.url })
        .from(developers)
        .where(eq(developers.ownerUserId, userId));
      if (!row) {
        return {
          data: null,
          error: {
            message: "You don't own a developer profile",
            code: "NOT_FOUND"
          }
        };
      }

      const identity = await new UsersDatabase(this.db).getGithubIdentity(
        userId
      );
      if (identity.error || !identity.data) {
        return {
          data: null,
          error: identity.error ?? {
            message: "Failed to load caller's GitHub identity",
            code: "DATABASE_ERROR"
          }
        };
      }

      // No linked GitHub identity at all shouldn't be reachable in practice
      // (GitHub is this system's sole login provider), but stays a no-op
      // rather than writing a misleading "unverified" result over it.
      if (!identity.data.githubLogin) {
        return this.getById(row.id);
      }

      const matches = matchesClaimant(
        row.type as Developer["type"],
        row.id,
        identity.data
      );

      // Only bothers with the extra GitHub API call when the identity match
      // above still holds — a URL "verified" against an entity the caller no
      // longer controls wouldn't mean anything. When identity no longer
      // matches, any previously-set githubUrlVerified is cleared below
      // (cheap — no API call needed, same as githubOrgVerified itself).
      let githubUrlVerified: number | null = null;
      let writeUrlVerified = false;
      if (!matches) {
        writeUrlVerified = true;
      } else if (checkUrl) {
        const entity = await checkGithubEntity(row.id, githubToken ?? "");
        // A failed lookup (rate limit, network, auth error) is inconclusive,
        // not a disproof — checkGithubEntity can't tell the two apart (see
        // its own docstring) — so it leaves the stored signal untouched
        // rather than clearing a real prior verification over a transient
        // failure. Only a successful lookup, of the entity type the profile
        // itself claims, gets to overwrite it.
        if (entity) {
          writeUrlVerified = true;
          githubUrlVerified =
            entity.type === row.type &&
            urlMatchesGithubBlog(row.url ?? undefined, entity.blog)
              ? 1
              : null;
        }
      }

      // Re-asserts ownership in the write itself (not just the lookup
      // above) — otherwise a transfer/claim landing in between would let
      // this write a result computed from the *former* owner's GitHub
      // identity onto the profile after it's changed hands. Same guard as
      // upsertOwn's update branch.
      const result = await this.db
        .update(developers)
        .set({
          githubOrgVerified: matches ? 1 : 0,
          ...(writeUrlVerified ? { githubUrlVerified } : {}),
          githubVerificationNote: matches
            ? "Verified: caller's linked GitHub identity matches."
            : "No longer verified: caller's linked GitHub identity no longer matches.",
          githubVerifiedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(eq(developers.id, row.id), eq(developers.ownerUserId, userId))
        );

      if (!result.meta?.changes) {
        return {
          data: null,
          error: {
            message: "Developer ownership changed while re-verifying",
            code: "CONFLICT"
          }
        };
      }

      return this.getById(row.id);
    } catch (error) {
      return databaseError("reverifyOwn", error);
    }
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

        const check = await this.verifyGithubOwnership(
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
        result = await this.db.run(sql`
          INSERT INTO ${developerClaims} (id, developer_id, claimant_id, note, github_org_verified, github_verification_note)
             SELECT ${id}, ${developerId}, ${claimantId}, ${note ?? null}, ${githubOrgVerified}, ${githubVerificationNote}
             WHERE EXISTS (SELECT 1 FROM ${developers} WHERE id = ${developerId} AND owner_user_id IS NULL)
               AND NOT EXISTS (SELECT 1 FROM ${developers} WHERE owner_user_id = ${claimantId})
        `);
      } catch (error) {
        if (isPendingClaimConflict(error)) {
          return {
            data: null,
            error: {
              code: "CONFLICT",
              message: "You already have a pending claim on this profile"
            }
          };
        }
        return databaseError("claim", error);
      }

      if (!result.meta?.changes) {
        return {
          data: null,
          error: await this.claimIneligibilityError(developerId)
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
      result = await this.db
        .delete(developerClaims)
        .where(
          and(
            eq(developerClaims.id, claimId),
            eq(developerClaims.claimantId, claimantId),
            eq(developerClaims.status, "pending")
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

  async listMyClaims(
    claimantId: string
  ): Promise<DatabaseResult<DeveloperClaim[]>> {
    let rows;
    try {
      rows = await this.db
        .select()
        .from(developerClaims)
        .where(eq(developerClaims.claimantId, claimantId))
        .orderBy(desc(developerClaims.createdAt));
    } catch (error) {
      return databaseError("listMyClaims", error);
    }

    return { data: rows.map(parseClaimRow), error: null };
  }

  async listPendingClaims(): Promise<DatabaseResult<PendingDeveloperClaim[]>> {
    let rows;
    try {
      rows = await this.db
        .select({
          claim: developerClaims,
          developerName: developers.name,
          developerType: developers.type,
          claimantName: externalUsers.name,
          claimantGithubLogin: externalUsers.githubLogin
        })
        .from(developerClaims)
        .innerJoin(developers, eq(developers.id, developerClaims.developerId))
        .leftJoin(externalUsers, eq(externalUsers.id, developerClaims.claimantId))
        .where(eq(developerClaims.status, "pending"))
        .orderBy(asc(developerClaims.createdAt));
    } catch (error) {
      return databaseError("listPendingClaims", error);
    }

    return {
      data: rows.map((row) => ({
        ...parseClaimRow(row.claim),
        developer_name: row.developerName,
        developer_type:
          row.developerType as PendingDeveloperClaim["developer_type"],
        claimant_name: row.claimantName,
        claimant_github_login: row.claimantGithubLogin
      })),
      error: null
    };
  }

  // Best-effort compensation: if the write-through after claiming the status
  // transition fails, put the claim back to 'pending' rather than leaving it
  // permanently 'approved' with no matching ownership change.
  private async revertClaimToPending(id: string): Promise<void> {
    try {
      await this.db
        .update(developerClaims)
        .set({ status: "pending", reviewerId: null, reviewedAt: null })
        .where(eq(developerClaims.id, id));
    } catch {
      // best-effort only
    }
  }

  async approveClaim(
    claimId: string,
    reviewerId: string
  ): Promise<DatabaseResult<DeveloperProfile>> {
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

      const [conflict] = await this.db
        .select({ one: sql`1` })
        .from(developers)
        .where(eq(developers.ownerUserId, claim.claimant_id));
      if (conflict) {
        return {
          data: null,
          error: {
            message: "The claimant already owns a different developer profile",
            code: "CONFLICT"
          }
        };
      }
    } catch (error) {
      return databaseError("approveClaim", error);
    }

    // Claim the transition atomically before writing anything through. If
    // this affects no rows, a concurrent approve/reject already won the race.
    let claimResult;
    try {
      claimResult = await this.db
        .update(developerClaims)
        .set({
          status: "approved",
          reviewerId,
          reviewedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(developerClaims.id, claimId),
            eq(developerClaims.status, "pending")
          )
        );
    } catch (error) {
      return databaseError("approveClaim", error);
    }

    if (!claimResult.meta?.changes) {
      return {
        data: null,
        error: { message: "Claim is not pending", code: "CONFLICT" }
      };
    }

    // The ownership write is itself guarded by `owner_user_id IS NULL`, so a
    // second concurrent approval of a *different* pending claim on the same
    // developer (each claim id claims its own status row above, so both
    // could reach this point) can't also move ownership — only the first to
    // commit here wins, and the loser's developerStmt affects zero rows,
    // caught below. rejectOthersStmt is gated on that same win via
    // `changes() = 1`, so competing claims are only auto-rejected once
    // ownership has actually moved, not whenever this batch merely runs.
    // Both batched via the raw D1 client (see toD1Statement / upsertOwn's
    // historyStmt comment) - rejectOthersStmt's changes()=1 gate needs it
    // regardless, and mixing a query builder item with a raw one in the
    // same batch hits the same drizzle-orm bug either way.
    let results;
    try {
      const developerStmt = this.db
        .update(developers)
        .set({
          ownerUserId: claim.claimant_id,
          ownershipEpoch: sql`ownership_epoch + 1`,
          contentRevision: sql`content_revision + 1`,
          approvedAt: null,
          approvedRevision: null,
          approvedBy: null,
          // Carries the claim's own verification result onto the profile it
          // just transferred ownership to — verifyGithubOwnership() already
          // ran once, inside claim() itself, so this isn't a fresh check.
          // github_verified_at uses the claim's created_at (when that check
          // actually ran), not this approval time.
          githubOrgVerified:
            claim.github_org_verified === undefined
              ? null
              : claim.github_org_verified
                ? 1
                : 0,
          githubVerificationNote: claim.github_verification_note ?? null,
          githubVerifiedAt:
            claim.github_org_verified === undefined ? null : claim.created_at,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(developers.id, claim.developer_id),
            isNull(developers.ownerUserId)
          )
        );
      const rejectOthersStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE developer_claims SET status = 'rejected', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP,
                review_note = 'Another claim on this profile was approved'
              WHERE changes() = 1 AND developer_id = ? AND status = 'pending' AND id != ?`,
        params: [reviewerId, claim.developer_id, claimId]
      });

      results = await this.db.$client.batch([
        toD1Statement(this.db.$client, developerStmt.toSQL()),
        rejectOthersStmt
      ]);
    } catch (error) {
      await this.revertClaimToPending(claimId);
      return databaseError("approveClaim", error);
    }

    const [developerResult] = results;
    if (!developerResult.meta?.changes) {
      await this.revertClaimToPending(claimId);
      return {
        data: null,
        error: {
          message: "This profile is no longer unowned",
          code: "CONFLICT"
        }
      };
    }

    return this.getById(claim.developer_id);
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
            eq(developerClaims.status, "pending")
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
