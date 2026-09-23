import { and, asc, desc, eq, gt, isNull, lt, or, sql, SQL } from "drizzle-orm";
import { DatabaseResult } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { encodeCursor as encode, decodeCursor as decode } from "./cursor";
import {
  developers,
  developerHistory,
  developerTransfers,
  extensions,
  users
} from "./schema";
import { databaseError } from "./errors";
import { toD1Statement } from "./batch";
import { optionalBool } from "./columns";
import {
  checkGithubEntity,
  matchesClaimant,
  urlMatchesGithubBlog
} from "../github/verification";
import {
  Developer,
  DeveloperHistoryEntry,
  DeveloperProfile
} from "../schemas/developers";
import {
  githubUnavailableError,
  verifyGithubOwnership
} from "../github/identity";
import { UsersDatabase } from "./users";

const URL_CHECK_COOLDOWN_SECONDS = 60;

type DeveloperRow = typeof developers.$inferSelect;

function parseDeveloperRow(row: DeveloperRow): DeveloperProfile {
  return {
    id: row.id,
    type: row.type as DeveloperProfile["type"],
    name: row.name,
    URL: row.url ?? undefined,
    avatar_url: row.avatarUrl ?? undefined,
    contact_email: row.contactEmail ?? undefined,
    approved:
      row.approvedAt != null &&
      (row.approvedRevision == null ||
        Number(row.approvedRevision) === Number(row.contentRevision ?? 1)),
    content_revision: Number(row.contentRevision ?? 1),
    github_org_verified: optionalBool(row.githubOrgVerified),
    github_verification_note: row.githubVerificationNote ?? undefined,
    github_verified_at: row.githubVerifiedAt ?? undefined,
    github_url_verified: row.githubUrlVerified === 1 ? true : undefined
  };
}

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

export class DeveloperProfilesDatabase {
  constructor(private db: ExtensionsDb) {}

  // The minimum an extension write needs about the caller's profile: which
  // developer to publish under, and the ownership epoch to pin the write to.
  // getOwn() is the full profile projection and deliberately does not expose
  // ownership_epoch, which is an internal concurrency token rather than part
  // of the public contract.
  async getOwnRef(
    userId: string
  ): Promise<DatabaseResult<{ id: string; ownershipEpoch: number } | null>> {
    try {
      const [row] = await this.db
        .select({
          id: developers.id,
          ownershipEpoch: developers.ownershipEpoch
        })
        .from(developers)
        .where(eq(developers.ownerUserId, userId));
      return {
        data: row
          ? { id: row.id, ownershipEpoch: Number(row.ownershipEpoch ?? 1) }
          : null,
        error: null
      };
    } catch (error) {
      return databaseError("getOwnRef", error);
    }
  }
  async getOwn(
    userId: string
  ): Promise<
    | DatabaseResult<DeveloperProfile & { has_pending_transfer: boolean }>
    | { data: null; error: null }
  > {
    try {
      // The pending-transfer probe is folded in as a correlated EXISTS so
      // GET /developers/me (and the developer detail route's Promise.all)
      // costs one D1 round trip instead of two serial ones.
      const [row] = await this.db
        .select({
          developer: developers,
          hasPendingTransfer: sql<boolean>`EXISTS (
            SELECT 1 FROM ${developerTransfers}
            WHERE ${developerTransfers.developerId} = ${developers.id}
              AND ${developerTransfers.acceptedAt} IS NULL
              AND ${developerTransfers.revokedAt} IS NULL
              AND ${developerTransfers.expiresAt} > CURRENT_TIMESTAMP
          )`
        })
        .from(developers)
        .where(eq(developers.ownerUserId, userId));
      if (!row) return { data: null, error: null };

      return {
        data: {
          ...parseDeveloperRow(row.developer),
          unclaimed: false,
          // SQLite answers EXISTS with 0/1, not a boolean.
          has_pending_transfer: Number(row.hasPendingTransfer) === 1
        },
        error: null
      };
    } catch (error) {
      return databaseError("getOwn", error);
    }
  }

  // githubToken — see the comment on verifyGithubOwnership(). Only consulted
  // when creating a brand-new profile (developer.id is immutable once
  // owned, so an update can't need re-verifying); guards against squatting
  // on an id that matches a real GitHub org/user the caller doesn't control,
  // the one gap claim() alone can't close since it only ever applies to
  // rows that already exist unowned.
  async upsertOwn(
    userId: string,
    developer: Developer,
    githubToken?: string,
    allowCreationAttempt: () => Promise<boolean> = async () => true
  ): Promise<DatabaseResult<DeveloperProfile>> {
    try {
      // Independent lookups - "does this caller already own a profile" and
      // "is this id taken" - so they go out together rather than costing two
      // serial round trips on every PUT /developers/me.
      const [[existingOwn], [existingById]] = await Promise.all([
        this.db
          .select()
          .from(developers)
          .where(eq(developers.ownerUserId, userId)),
        this.db.select().from(developers).where(eq(developers.id, developer.id))
      ]);
      const isCreating = !existingOwn;

      let githubOrgVerified: number | null = null;
      let githubUrlVerified: number | null = null;
      let githubVerificationNote: string | null = null;

      let mainStmt: D1PreparedStatement;
      if (isCreating) {
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

        // This hook sits after both cheap D1 existence checks and directly
        // before the creation-only GitHub lookup. The Worker supplies the
        // configured account limiter; keeping it as a callback leaves this
        // database/service module runtime-agnostic and ensures updates and
        // already-taken ids never spend creation allowance.
        if (!(await allowCreationAttempt())) {
          return {
            data: null,
            error: {
              message:
                "Too many new profile creation attempts; try again in 60 seconds",
              code: "PROFILE_CREATION_RATE_LIMITED"
            }
          };
        }

        const check = await verifyGithubOwnership(
          this.db,
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

        // INSERT ... SELECT makes the active-account check part of the
        // mutation itself. The middleware check is only an early rejection;
        // a deletion can win between that check and this statement.
        mainStmt = toD1Statement(this.db.$client, {
          sql: `INSERT INTO developers (
                  id, type, name, url, avatar_url, contact_email,
                  owner_user_id, approved_at, created_at, updated_at,
                  github_org_verified,
                  github_verification_note, github_verified_at,
                  github_url_verified
                )
                SELECT ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP,
                       CURRENT_TIMESTAMP, ?, ?,
                       CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
                       ?
                WHERE EXISTS (
                  SELECT 1 FROM users
                  WHERE id = ? AND deleted_at IS NULL
                )
                ON CONFLICT DO NOTHING`,
          params: [
            developer.id,
            developer.type,
            developer.name,
            developer.URL ?? null,
            developer.avatar_url ?? null,
            developer.contact_email ?? null,
            userId,
            githubOrgVerified,
            githubVerificationNote,
            githubOrgVerified,
            githubUrlVerified,
            userId
          ]
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
        const keepsApproval =
          !typeChanged && existingOwn.githubOrgVerified === 1;

        const updateStmt = this.db
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
              eq(developers.ownerUserId, userId),
              sql`EXISTS (
                SELECT 1 FROM ${users}
                WHERE ${users.id} = ${userId} AND ${users.deletedAt} IS NULL
              )`
            )
          );
        mainStmt = toD1Statement(this.db.$client, updateStmt.toSQL());
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
        results = await this.db.$client.batch([mainStmt, historyStmt]);
      } catch (error) {
        return databaseError("upsertOwn", error);
      }

      if (!results[0]?.meta?.changes) {
        return {
          data: null,
          error: await this.upsertBlockedError(userId, developer.id, isCreating)
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

  // The guarded upsert affected no rows. Either its WHERE rejected the caller
  // or ON CONFLICT DO NOTHING swallowed a unique violation, so work through
  // the same conditions the statement checked. DEVELOPER_ID_TAKEN is a
  // distinct code rather than a generic CONFLICT because the create-profile
  // form uses it to redirect the user to the claim flow.
  private async upsertBlockedError(
    userId: string,
    developerId: string,
    isCreating: boolean
  ): Promise<{ message: string; code: string }> {
    const [activeUser] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
    if (!activeUser) {
      return { message: "Active account required", code: "ACCOUNT_INACTIVE" };
    }

    if (isCreating) {
      const [takenId, ownProfile] = await Promise.all([
        this.db
          .select({ id: developers.id })
          .from(developers)
          .where(eq(developers.id, developerId)),
        this.db
          .select({ id: developers.id })
          .from(developers)
          .where(eq(developers.ownerUserId, userId))
      ]);
      if (takenId.length > 0) {
        return {
          message: "Developer id already exists",
          code: "DEVELOPER_ID_TAKEN"
        };
      }
      if (ownProfile.length > 0) {
        return {
          message: "You already have a developer profile",
          code: "CONFLICT"
        };
      }
    }

    return {
      message: "Developer ownership changed while updating the profile",
      code: "CONFLICT"
    };
  }

  // Diagnoses why the guarded delete in deleteOwn() below affected zero
  // rows: distinguishes an inactive caller, no-longer-owned/nonexistent,
  // and the two blocking conditions, without reopening the race the guard
  // already closed.
  private async deletionBlockedError(
    developerId: string,
    userId: string
  ): Promise<{
    code: "NOT_FOUND" | "CONFLICT" | "ACCOUNT_INACTIVE";
    message: string;
  }> {
    const [developer] = await this.db
      .select({ ownerUserId: developers.ownerUserId })
      .from(developers)
      .where(eq(developers.id, developerId));

    if (!developer || developer.ownerUserId !== userId) {
      return { code: "NOT_FOUND", message: "Developer not found" };
    }

    const [user] = await this.db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!user || user.deletedAt !== null) {
      return {
        code: "ACCOUNT_INACTIVE",
        message: "Active account required"
      };
    }

    const [extensionCount] = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(extensions)
      .where(eq(extensions.developerId, developerId));
    const extensionsCount = extensionCount?.count ?? 0;
    if (extensionsCount > 0) {
      return {
        code: "CONFLICT",
        message: `You have ${extensionsCount} extension(s) under this profile. Transfer ownership, or withdraw the unpublished ones, before deleting it.`
      };
    }

    // The guard failed but a fresh look finds nothing wrong — whatever
    // blocked it (someone else's transfer/claim landing, an extension that
    // has since been withdrawn) has already cleared. Ask the caller to retry
    // rather than guessing at a reason that's no longer true.
    return {
      code: "CONFLICT",
      message:
        "Your profile changed while processing this request. Please try again."
    };
  }

  // Permanently removes the caller's own developer profile, for a
  // privacy-focused account-deletion flow. Refuses while anything would be
  // left dangling in a way that isn't just historical record-keeping:
  // any extensions at all (someone still needs to own them, and extensions
  // .developer_id is a hard FK). Unpublished ones count: withdrawing them is
  // owner's own one-call operation. Pending revisions need no separate check
  // since migration 0021 - every revision belongs to an extension and
  // cascades with it, so "no extensions" already implies "nothing left to
  // review". developer_history is deliberately left alone —
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
      // no extensions attached) at the moment it runs, rather than trusting
      // the SELECT above: ownership can move (an accepted transfer/claim) and
      // a new extension can appear between that check and this write, and this
      // delete is the caller's only authorization check. The same guard is
      // repeated on all three statements — not just the last — so they're
      // all-or-nothing: if it fails, nothing here is touched, instead of
      // transfers/claims being deleted out from under a profile whose own
      // deletion then gets blocked. Kept as raw sql via $client (see
      // toD1Statement): the correlated EXISTS subqueries reference the
      // outer statement's own table name, which the query builder can't
      // express, and this batch needs the raw-D1 escape hatch regardless
      // (see upsertOwn's historyStmt comment).
      // Parameterised by the developers-table reference: the two child-table
      // deletes reach the predicate through a correlated EXISTS, while the
      // developers delete applies it directly to the row being removed -
      // wrapping that one in EXISTS (SELECT 1 FROM developers ...) would let
      // the inner table shadow the outer and pass whenever *any* profile were
      // deletable. Parameters, in order: owner user id, then active user id.
      const deletable = (dev: string) => `${dev}.owner_user_id = ?
                    AND NOT EXISTS (SELECT 1 FROM extensions WHERE extensions.developer_id = ${dev}.id)
                    AND EXISTS (
                      SELECT 1 FROM users active_user
                      WHERE active_user.id = ? AND active_user.deleted_at IS NULL
                    )`;

      const ownedAndDeletable = (developerIdColumn: string) => `EXISTS (
                  SELECT 1 FROM developers
                  WHERE developers.id = ${developerIdColumn}
                    AND ${deletable("developers")}
                )`;

      const deleteTransfersStmt = toD1Statement(this.db.$client, {
        sql: `DELETE FROM developer_transfers
              WHERE developer_id = ?
                AND ${ownedAndDeletable("developer_transfers.developer_id")}`,
        params: [developer.id, userId, userId]
      });

      const deleteClaimsStmt = toD1Statement(this.db.$client, {
        sql: `DELETE FROM developer_claims
              WHERE developer_id = ?
                AND ${ownedAndDeletable("developer_claims.developer_id")}`,
        params: [developer.id, userId, userId]
      });

      const deleteDeveloperStmt = toD1Statement(this.db.$client, {
        sql: `DELETE FROM developers
              WHERE id = ?
                AND ${deletable("developers")}`,
        params: [developer.id, userId, userId]
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

  async getById(
    id: string
  ): Promise<DatabaseResult<DeveloperProfile & { unclaimed: boolean }>> {
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
      return {
        data: {
          ...parseDeveloperRow(row),
          unclaimed: row.ownerUserId === null
        },
        error: null
      };
    } catch (error) {
      return databaseError("getById", error);
    }
  }

  // The two moderator listings differ only by filter and sort order. They are
  // the only readers that join users for owner_name/owner_github_login, which
  // is why DeveloperProfile treats those fields as optional.
  //
  // Keyset (cursor) pagination, matching GET /extensions and GET /revisions:
  // limit+1 probe answers has_more and is trimmed off. Ties are broken by
  // rowid (insertion order) — the order keys alone (name, created_at) are
  // not unique and timestamps are second-granular, so same-second ties are
  // the common case, not the exception. The opaque cursor carries rowid;
  // it is never exposed outside the cursor.
  // The cursor tags its scope (`s`): `all` orders by name, `unapproved` by
  // created_at, so a cursor from one scope must 422 in the other rather than
  // compare names against timestamps.
  async listScoped(filters: {
    scope?: "all" | "unapproved";
    status?: "all" | "unapproved";
    limit?: number;
    cursor?: string;
  }): Promise<
    DatabaseResult<{
      items: DeveloperProfile[];
      nextCursor: string | null;
      hasMore: boolean;
    }>
  > {
    const scope = filters.scope ?? filters.status ?? "all";
    const limit = filters.limit ?? 50;
    const decoded = filters.cursor
      ? decodeDeveloperCursor(filters.cursor)
      : null;
    if (filters.cursor && !decoded) {
      return {
        data: null,
        error: { message: "Invalid pagination cursor", code: "INVALID_CURSOR" }
      };
    }
    if (decoded && decoded.s !== scope) {
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

    const conditions: SQL[] = [];
    let orderBy;
    if (scope === "unapproved") {
      conditions.push(isNull(developers.approvedAt));
      if (decoded) {
        conditions.push(
          or(
            gt(developers.createdAt, decoded.k1),
            and(
              eq(developers.createdAt, decoded.k1),
              sql`"developers".rowid > ${afterRowid}`
            )
          )!
        );
      }
      orderBy = [
        asc(developers.createdAt),
        sql`"developers".rowid ASC`
      ] as const;
    } else {
      if (decoded) {
        conditions.push(
          or(
            gt(developers.name, decoded.k1),
            and(
              eq(developers.name, decoded.k1),
              sql`"developers".rowid > ${afterRowid}`
            )
          )!
        );
      }
      orderBy = [asc(developers.name), sql`"developers".rowid ASC`] as const;
    }

    let rows;
    try {
      rows = await this.db
        .select({
          developer: developers,
          ownerName: users.name,
          ownerGithubLogin: users.githubLogin,
          rowid: sql<number>`"developers".rowid`
        })
        .from(developers)
        .leftJoin(users, eq(users.id, developers.ownerUserId))
        .where(conditions.length ? and(...conditions)! : undefined)
        .orderBy(...orderBy)
        .limit(limit + 1);
    } catch (error) {
      return databaseError("listScoped", error);
    }

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      data: {
        items: pageRows.map(parseDeveloperRowWithOwner),
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeDeveloperCursor(
                scope,
                scope === "unapproved"
                  ? last.developer.createdAt
                  : last.developer.name,
                String(last.rowid)
              )
            : null
      },
      error: null
    };
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
            eq(developers.contentRevision, expectedRevision),
            sql`EXISTS (
              SELECT 1 FROM ${users}
              WHERE ${users.id} = ${reviewerId} AND ${users.deletedAt} IS NULL
            )`
          )
        );
    } catch (error) {
      return databaseError("approve", error);
    }

    if (!result.meta?.changes) {
      let reviewer: { deletedAt: string | null } | undefined;
      try {
        [reviewer] = await this.db
          .select({ deletedAt: users.deletedAt })
          .from(users)
          .where(eq(users.id, reviewerId));
      } catch (error) {
        return databaseError("approve", error);
      }
      if (!reviewer || reviewer.deletedAt !== null) {
        return {
          data: null,
          error: {
            code: "ACCOUNT_INACTIVE",
            message: "Active account required"
          }
        };
      }

      const existing = await this.getById(id);
      if (existing.error) {
        // A failed diagnostic lookup is not evidence that the developer is
        // missing. Preserve database errors (and any other lookup error) so
        // transient failures are not misreported as HTTP 404.
        return { data: null, error: existing.error };
      }

      return {
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

  // Newest-first keyset pages of one developer's audit history.
  // CURRENT_TIMESTAMP has only second resolution, so two writes in the same
  // second tie on changed_at; rowid (insertion order) breaks the tie so
  // "newest first" is never ambiguous, exactly as the offset implementation
  // did. The opaque cursor carries rowid.
  async listHistory(
    developerId: string,
    page?: { limit?: number; cursor?: string }
  ): Promise<
    DatabaseResult<{
      items: DeveloperHistoryEntry[];
      nextCursor: string | null;
      hasMore: boolean;
    }>
  > {
    const limit = page?.limit ?? 50;
    const decoded = page?.cursor ? decodeHistoryCursor(page.cursor) : null;
    if (page?.cursor && !decoded) {
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

    let rows;
    try {
      const conditions = [eq(developerHistory.developerId, developerId)];
      if (decoded) {
        conditions.push(
          or(
            lt(developerHistory.changedAt, decoded.k1),
            and(
              eq(developerHistory.changedAt, decoded.k1),
              sql`"developer_history".rowid < ${afterRowid}`
            )
          )!
        );
      }
      rows = await this.db
        .select({
          developerId: developerHistory.developerId,
          type: developerHistory.type,
          name: developerHistory.name,
          url: developerHistory.url,
          changedBy: developerHistory.changedBy,
          changedByName: users.name,
          changedAt: developerHistory.changedAt,
          rowid: sql<number>`"developer_history".rowid`
        })
        .from(developerHistory)
        .leftJoin(users, eq(users.id, developerHistory.changedBy))
        .where(and(...conditions))
        .orderBy(
          desc(developerHistory.changedAt),
          sql`"developer_history".rowid DESC`
        )
        .limit(limit + 1);
    } catch (error) {
      return databaseError("listHistory", error);
    }

    const hasMore = rows.length > limit;
    const trimmed = rows.slice(0, limit);
    const last = trimmed.at(-1);

    return {
      data: {
        items: trimmed.map((row) => ({
          developer_id: row.developerId,
          type: row.type as DeveloperHistoryEntry["type"],
          name: row.name,
          URL: row.url ?? undefined,
          changed_by: row.changedBy,
          changed_by_name: row.changedByName,
          changed_at: row.changedAt
        })),
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeHistoryCursor(last.changedAt, String(last.rowid))
            : null
      },
      error: null
    };
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
        .select({
          id: developers.id,
          type: developers.type,
          url: developers.url
        })
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

      if (checkUrl) {
        // Atomic conditional UPDATE, not a read-then-write — the WHERE
        // clause only matches (and thus only "wins") when the cooldown is
        // absent or already expired, so two concurrent check_url requests
        // can't both pass. This is the only reason check_url spends a real
        // GitHub API call, so it's the only path that needs this.
        const cooldown = await this.db
          .update(developers)
          .set({
            urlCheckCooldownUntil: sql`datetime('now', ${`+${URL_CHECK_COOLDOWN_SECONDS} seconds`})`
          })
          .where(
            and(
              eq(developers.id, row.id),
              eq(developers.ownerUserId, userId),
              sql`EXISTS (
                SELECT 1 FROM ${users}
                WHERE ${users.id} = ${userId} AND ${users.deletedAt} IS NULL
              )`,
              or(
                isNull(developers.urlCheckCooldownUntil),
                sql`${developers.urlCheckCooldownUntil} < CURRENT_TIMESTAMP`
              )
            )
          );
        if (!cooldown.meta?.changes) {
          const [activeUser] = await this.db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, userId), isNull(users.deletedAt)));
          if (!activeUser) {
            return {
              data: null,
              error: {
                message: "Active account required",
                code: "ACCOUNT_INACTIVE"
              }
            };
          }
          return {
            data: null,
            error: {
              message:
                "Please wait a minute before re-checking your Publisher URL again.",
              code: "RATE_LIMITED"
            }
          };
        }
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
      if (!identity.data.githubLogin?.trim()) {
        return this.getById(row.id);
      }

      // An expired or malformed organization-membership snapshot is
      // inconclusive, not proof that the owner left the organization. Keep
      // the stored verification signal and timestamp until central auth
      // supplies a fresh snapshot. The cooldown (when check_url was used)
      // was already reserved above, so this remains bounded even on retries.
      if (row.type === "organization" && !identity.data.githubOrgsAvailable) {
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
      // Set when a fresh lookup (only possible when checkUrl actually ran)
      // finds GitHub's *current* entity type no longer matches the
      // profile's own type — matchesClaimant() above only compares
      // login/org membership, it never confirms the entity is still the
      // type the profile claims, unlike creation-time verification. This
      // downgrades the identity signal too, not just the URL one, since the
      // same discrepancy undermines both.
      let identityTypeContradicted = false;
      if (!matches) {
        writeUrlVerified = true;
      } else if (checkUrl) {
        const entity = await checkGithubEntity(row.id, githubToken ?? "");
        // An unavailable lookup is explicitly inconclusive, not a disproof,
        // so it leaves the stored URL verification signal untouched rather
        // than clearing a real prior verification over a transient failure.
        // A confirmed absence likewise provides no website to compare. Only
        // a successful lookup gets to overwrite the stored URL signal.
        if (entity.status === "unavailable") {
          // Keep the cooldown reservation even though no signal was changed.
          // Otherwise a caller could repeatedly hit GitHub while the shared
          // service token is throttled or the upstream service is failing.
          return { data: null, error: githubUnavailableError(entity.reason) };
        }
        if (entity.status === "found") {
          writeUrlVerified = true;
          if (entity.entity.type !== row.type) {
            identityTypeContradicted = true;
          } else {
            githubUrlVerified = urlMatchesGithubBlog(
              row.url ?? undefined,
              entity.entity.blog
            )
              ? 1
              : null;
          }
        }
      }
      const verified = matches && !identityTypeContradicted;

      // Re-asserts ownership in the write itself (not just the lookup
      // above) — otherwise a transfer/claim landing in between would let
      // this write a result computed from the *former* owner's GitHub
      // identity onto the profile after it's changed hands. Same guard as
      // upsertOwn's update branch. Also re-asserts the URL is still the one
      // just checked — otherwise a concurrent Publisher URL edit landing in
      // between would let a stale URL comparison get written as if it
      // described the new URL. Finally, the users predicates below re-check
      // the exact GitHub identity snapshot used for this result, so a newer
      // central-auth sync cannot be overwritten by this in-flight request.
      const sameGithubIdentity = [
        identity.data.githubLogin === null
          ? isNull(users.githubLogin)
          : eq(users.githubLogin, identity.data.githubLogin),
        identity.data.githubOrgsSnapshot === null
          ? isNull(users.githubOrgs)
          : eq(users.githubOrgs, identity.data.githubOrgsSnapshot),
        identity.data.githubOrgsExpiresAt === null
          ? isNull(users.githubOrgsExpiresAt)
          : eq(users.githubOrgsExpiresAt, identity.data.githubOrgsExpiresAt)
      ];
      const result = await this.db
        .update(developers)
        .set({
          githubOrgVerified: verified ? 1 : 0,
          ...(writeUrlVerified ? { githubUrlVerified } : {}),
          githubVerificationNote: verified
            ? "Verified: caller's linked GitHub identity matches."
            : identityTypeContradicted
              ? "No longer verified: GitHub's on-file entity type no longer matches this profile."
              : "No longer verified: caller's linked GitHub identity no longer matches.",
          githubVerifiedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(developers.id, row.id),
            eq(developers.type, row.type),
            eq(developers.ownerUserId, userId),
            sql`EXISTS (
              SELECT 1 FROM ${users}
              WHERE ${users.id} = ${userId} AND ${users.deletedAt} IS NULL
                AND ${sameGithubIdentity[0]}
                AND ${sameGithubIdentity[1]}
                AND ${sameGithubIdentity[2]}
            )`,
            ...(writeUrlVerified
              ? [
                  row.url === null
                    ? isNull(developers.url)
                    : eq(developers.url, row.url)
                ]
              : [])
          )
        );

      if (!result.meta?.changes) {
        return {
          data: null,
          error: {
            message:
              "Developer ownership or Publisher URL changed while re-verifying",
            code: "CONFLICT"
          }
        };
      }

      return this.getById(row.id);
    } catch (error) {
      return databaseError("reverifyOwn", error);
    }
  }
}

interface DeveloperListCursor {
  k1: string;
  k2: string;
  s: "all" | "unapproved";
}

function encodeDeveloperCursor(
  scope: "all" | "unapproved",
  k1: string,
  k2: string
): string {
  return encode({ k1, k2, s: scope });
}

function isDeveloperListCursor(
  parsed: Record<string, unknown>
): parsed is DeveloperListCursor & Record<string, unknown> {
  return (
    typeof parsed.k1 === "string" &&
    typeof parsed.k2 === "string" &&
    (parsed.s === "all" || parsed.s === "unapproved")
  );
}

function decodeDeveloperCursor(cursor: string): DeveloperListCursor | null {
  return decode(cursor, isDeveloperListCursor);
}

interface HistoryCursor {
  k1: string;
  k2: string;
}

function encodeHistoryCursor(k1: string, k2: string): string {
  return encode({ k1, k2 });
}

function isHistoryCursor(
  parsed: Record<string, unknown>
): parsed is HistoryCursor & Record<string, unknown> {
  return typeof parsed.k1 === "string" && typeof parsed.k2 === "string";
}

function decodeHistoryCursor(cursor: string): HistoryCursor | null {
  return decode(cursor, isHistoryCursor);
}
