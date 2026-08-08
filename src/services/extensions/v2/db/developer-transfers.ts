import { and, eq, isNull, sql } from "drizzle-orm";
import { DatabaseResult } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { developers, developerTransfers, users } from "./schema";
import {
  databaseError,
  isDeveloperOwnerConflict,
  isOwnershipEpochRollback
} from "./errors";
import { toD1Statement } from "./batch";
import { DeveloperProfile } from "../schemas/developers";
import { DeveloperTransfer } from "../schemas/ownership";
import { DeveloperProfilesDatabase } from "./developer-profiles";

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toSqliteDatetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// The developer this token has just been accepted for. Every statement in the
// acceptTransfer batch has to agree on it - a copy that drifted would target a
// different profile than the one the batch just transferred. Takes the token
// hash and accepting user as its two parameters, in that order.
const CLAIMED_DEVELOPER = `SELECT developer_id FROM developer_transfers
                WHERE token_hash = ? AND accepted_by = ? AND accepted_at IS NOT NULL`;

export class DeveloperTransfersDatabase {
  constructor(private db: ExtensionsDb) {}
  // Shared by initiateTransfer/revokeTransfer: both are owner-only actions on
  // an existing developer, so both need the same NOT_FOUND/FORBIDDEN/
  // ACCOUNT_INACTIVE check.
  private async checkOwnership(
    developerId: string,
    userId: string
  ): Promise<{
    code: "NOT_FOUND" | "FORBIDDEN" | "ACCOUNT_INACTIVE";
    message: string;
  } | null> {
    const [owner] = await this.db
      .select({
        ownerUserId: developers.ownerUserId,
        ownerDeletedAt: users.deletedAt
      })
      .from(developers)
      .leftJoin(users, eq(users.id, developers.ownerUserId))
      .where(eq(developers.id, developerId));

    if (!owner) {
      return { code: "NOT_FOUND", message: "Developer not found" };
    }
    if (owner.ownerUserId !== userId) {
      return { code: "FORBIDDEN", message: "You don't own this profile" };
    }
    if (owner.ownerDeletedAt !== null) {
      return { code: "ACCOUNT_INACTIVE", message: "Active account required" };
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
      const expiresAt = toSqliteDatetime(
        new Date(Date.now() + 24 * 60 * 60 * 1000)
      );

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
                AND EXISTS (
                  SELECT 1 FROM developers
                  WHERE developers.id = developer_transfers.developer_id
                    AND developers.owner_user_id = ?
                )
                AND EXISTS (
                  SELECT 1 FROM users
                  WHERE users.id = ? AND users.deleted_at IS NULL
                )`,
        params: [developerId, userId, userId]
      });
      const insertStmt = toD1Statement(this.db.$client, {
        sql: `INSERT INTO developer_transfers (id, developer_id, token_hash, created_by, expires_at)
              SELECT ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM developers WHERE id = ? AND owner_user_id = ?
              )
                AND EXISTS (
                  SELECT 1 FROM users
                  WHERE users.id = ? AND users.deleted_at IS NULL
                )`,
        params: [
          crypto.randomUUID(),
          developerId,
          tokenHash,
          userId,
          expiresAt,
          developerId,
          userId,
          userId
        ]
      });

      const results = await this.db.$client.batch([revokeStmt, insertStmt]);

      // The INSERT only writes a row when the ownership guard above passes,
      // so zero rows written means the caller doesn't currently own this
      // developer — a follow-up read distinguishes NOT_FOUND, ownership, and
      // inactive-account errors without reopening the race the guard closes.
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
             AND EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} AND ${users.deletedAt} IS NULL)
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

      // Keep the developer id separate from the transfer row that the batch
      // will claim. The accepting user can delete the newly transferred
      // profile immediately after the batch commits; deleteOwn() removes the
      // associated transfer row as part of that same operation. Looking up
      // the transfer after the commit would then lose the id of the profile
      // whose ownership was already moved and turn a successful handoff into
      // a spurious DATABASE_ERROR. This read is only an identity snapshot —
      // the claim and ownership guards below remain the authorization source
      // of truth.
      const [transferBeforeCommit] = await this.db
        .select({ developerId: developerTransfers.developerId })
        .from(developerTransfers)
        .where(eq(developerTransfers.tokenHash, tokenHash));
      const transferredDeveloperId = transferBeforeCommit?.developerId;

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
                AND NOT EXISTS (SELECT 1 FROM developers WHERE owner_user_id = ?)
                AND EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL)`,
        params: [userId, tokenHash, userId, userId]
      });
      const updateDeveloperStmt = toD1Statement(this.db.$client, {
        // url_check_cooldown_until is reset here too — it's keyed by
        // whichever user currently owns this row, so left unchanged it
        // would rate-limit the *new* owner's first check_url reverify for
        // whatever's left of the *previous* owner's cooldown window.
        //
        // github_org_verified/github_url_verified/github_verification_note/
        // github_verified_at are cleared for the same underlying reason:
        // they describe whether the *previous* owner's linked GitHub
        // identity matched this profile — a fact that says nothing about
        // the new owner, who was never checked. Unlike approveClaim() (the
        // other ownership-transfer path), there's no claim-time
        // verification to carry over here — a transfer is a bare handoff,
        // not a claim — so this can only ever fall back to null/unverified,
        // same as a brand-new profile with no GitHub identity yet.
        sql: `UPDATE developers
              SET owner_user_id = ?,
                  ownership_epoch = ownership_epoch + 1,
                  content_revision = content_revision + 1,
                  approved_at = NULL, approved_revision = NULL, approved_by = NULL,
                  url_check_cooldown_until = NULL,
                  github_org_verified = NULL, github_url_verified = NULL,
                  github_verification_note = NULL, github_verified_at = NULL,
                  updated_at = CURRENT_TIMESTAMP
              WHERE changes() = 1
                AND id = (${CLAIMED_DEVELOPER})`,
        params: [userId, tokenHash, userId]
      });

      // Re-assert that the ownership update was caused by this batch's fresh
      // claim before cleaning up the two kinds of pending work attached to
      // the developer. If claimStmt or updateDeveloperStmt matched zero
      // rows, this deliberately violates the ownership_epoch CHECK and D1
      // rolls the whole batch back. The assertion lets both cleanup UPDATEs
      // run without their own changes() gates, so a zero-row cleanup of one
      // table cannot suppress cleanup of the other table.
      const assertTransferStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE developers
              SET ownership_epoch = CASE WHEN changes() = 1 THEN ownership_epoch ELSE 0 END
              WHERE id = (${CLAIMED_DEVELOPER})`,
        params: [tokenHash, userId]
      });

      // Identical apart from the table, and both must stay that way: leaving
      // pending work attached to a profile whose owner just changed would put
      // it in front of the wrong moderator.
      const rejectPendingIn = (
        table: "extension_revisions" | "developer_claims"
      ) =>
        toD1Statement(this.db.$client, {
          sql: `UPDATE ${table}
              SET status = 'rejected',
                  review_note = 'Ownership changed before review',
                  reviewed_at = CURRENT_TIMESTAMP
              WHERE developer_id = (${CLAIMED_DEVELOPER})
                AND status = 'pending'`,
          params: [tokenHash, userId]
        });
      const rejectPendingRevisionsStmt = rejectPendingIn("extension_revisions");
      const rejectPendingClaimsStmt = rejectPendingIn("developer_claims");

      let results;
      try {
        results = await this.db.$client.batch([
          claimStmt,
          updateDeveloperStmt,
          assertTransferStmt,
          rejectPendingRevisionsStmt,
          rejectPendingClaimsStmt
        ]);
      } catch (error) {
        // A replayed token reaches the assertion with changes() = 0. The
        // deliberate CHECK failure rolls back the batch, and is handled like
        // any other unsuccessful claim below so callers still receive the
        // documented invalid/used/expired-link response.
        if (isOwnershipEpochRollback(error)) {
          results = [{ meta: { changes: 0 } }];
        } else {
          if (isDeveloperOwnerConflict(error)) {
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
      }

      const [claim] = results;
      if (!claim.meta?.changes) {
        // The claim can fail either because the token itself is bad (used,
        // revoked, expired, unknown) or because it's still valid but the
        // ownership guard rejected it — check which, for an accurate error.
        const [recipient] = await this.db
          .select({ deletedAt: users.deletedAt })
          .from(users)
          .where(eq(users.id, userId));

        // The active-account middleware runs before this transaction, so a
        // recipient can be deactivated in the small window before the
        // guarded claim. Preserve the documented inactive-account response
        // rather than misclassifying a still-pending token as an ownership
        // conflict.
        if (!recipient || recipient.deletedAt !== null) {
          return {
            data: null,
            error: {
              code: "ACCOUNT_INACTIVE",
              message: "Active account required"
            }
          };
        }

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

      if (!transferredDeveloperId) {
        return databaseError(
          "acceptTransfer",
          new Error("Claimed transfer row not found")
        );
      }

      return new DeveloperProfilesDatabase(this.db).getById(
        transferredDeveloperId
      );
    } catch (error) {
      return databaseError("acceptTransfer", error);
    }
  }
}
