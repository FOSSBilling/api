import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  check
} from "drizzle-orm/sqlite-core";

// The API owns the complete Extensions domain, including this user projection.
// The row is keyed by the central auth service's `sub`; authentication itself
// remains in the Extensions site, while this projection is the domain-side
// authorization and foreign-key anchor for developers, submissions, claims,
// transfers, and audit history.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email"),
  emailVerified: integer("email_verified").notNull().default(0),
  picture: text("picture"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  isModerator: integer("is_moderator").notNull().default(0),
  displayName: text("display_name"),
  githubLogin: text("github_login"),
  githubOrgs: text("github_orgs"),
  githubOrgsExpiresAt: text("github_orgs_expires_at"),
  deletedAt: text("deleted_at")
});

// Legacy catalogue table, now owned by the API along with the rest of the
// Extensions domain. The v1 read-only routes import this model rather than
// maintaining a second table definition. author_id's column name is kept for
// compatibility with the public v1 response, while its target followed
// developers in migration 0008.
export const extensions = sqliteTable(
  "extensions",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => developers.id),
    name: text("name").notNull(),
    description: text("description").notNull(),
    releases: text("releases").notNull(),
    website: text("website").notNull(),
    license: text("license").notNull(),
    iconUrl: text("icon_url"),
    readme: text("readme").notNull(),
    source: text("source").notNull(),
    version: text("version").notNull(),
    downloadUrl: text("download_url").notNull()
  },
  (table) => [
    index("idx_extensions_type").on(table.type),
    index("idx_extensions_author").on(table.authorId),
    index("idx_extensions_catalogue_order").on(
      sql`lower(${table.id})`,
      table.id
    ),
    index("idx_extensions_type_catalogue_order").on(
      table.type,
      sql`lower(${table.id})`,
      table.id
    ),
    index("idx_extensions_author_catalogue_order").on(
      table.authorId,
      sql`lower(${table.id})`,
      table.id
    )
  ]
);

// Legacy catalogue table renamed from authors to developers by migration
// 0008. The API owns the full table now; type/name/url are the original
// catalogue fields and the remaining columns were added by the v2 migrations.
// bio (added in 0003) was dropped in 0010 and is intentionally absent here.
export const developers = sqliteTable(
  "developers",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    url: text("url"),
    ownerUserId: text("owner_user_id").references(() => users.id),
    approvedAt: text("approved_at"),
    // Placeholder default from migration 0002 (SQLite rejects non-constant
    // ALTER TABLE ADD COLUMN defaults). Every write sets this explicitly
    // (see developers-database.ts) - the literal default is never actually
    // read, but it's part of the real column definition so it's kept here
    // for baseline-diff fidelity against the existing database.
    createdAt: text("created_at").notNull().default("1970-01-01T00:00:00.000Z"),
    updatedAt: text("updated_at").notNull().default("1970-01-01T00:00:00.000Z"),
    avatarUrl: text("avatar_url"),
    contactEmail: text("contact_email"),
    ownershipEpoch: integer("ownership_epoch").notNull().default(1),
    contentRevision: integer("content_revision").notNull().default(1),
    approvedRevision: integer("approved_revision"),
    approvedBy: text("approved_by"),
    githubOrgVerified: integer("github_org_verified"),
    githubVerificationNote: text("github_verification_note"),
    // Set whenever githubOrgVerified is (re-)computed to a definitive 0/1 —
    // see DevelopersDatabase.reverifyOwn(). Left null/stale on an
    // inconclusive check (no linked GitHub identity), same as
    // githubOrgVerified itself.
    githubVerifiedAt: text("github_verified_at"),
    // Whether `url` matches GitHub's own on-file website — see
    // github-verification.ts's urlMatchesGithubBlog(). Only ever 1 or null,
    // never 0 (see the schema comment on interfaces.ts's
    // DeveloperProfileSchema.github_url_verified for why).
    githubUrlVerified: integer("github_url_verified"),
    // Atomic per-owner cooldown gating reverifyOwn()'s check_url path (the
    // one that spends a real GitHub API call) — set via a conditional
    // UPDATE, not read-then-write, so concurrent requests can't both pass.
    // Null until the first check_url reverify.
    urlCheckCooldownUntil: text("url_check_cooldown_until")
  },
  (table) => [
    uniqueIndex("idx_developers_owner_unique").on(table.ownerUserId),
    index("idx_developers_approved").on(table.approvedAt),
    check(
      "developers_ownership_epoch_check",
      sql`${table.ownershipEpoch} >= 1`
    ),
    check(
      "developers_content_revision_check",
      sql`${table.contentRevision} >= 1`
    ),
    check(
      "developers_github_org_verified_check",
      sql`${table.githubOrgVerified} IN (0, 1)`
    ),
    // = 1 rather than IN (0, 1): this column is documented to only ever be
    // 1 or NULL, never 0 (see interfaces.ts's DeveloperProfileSchema
    // comment) — SQLite's CHECK already treats NULL as satisfying `= 1`, so
    // this enforces that invariant instead of just validating it's a 0/1.
    check(
      "developers_github_url_verified_check",
      sql`${table.githubUrlVerified} = 1`
    )
  ]
);

export const extensionSubmissions = sqliteTable(
  "extension_submissions",
  {
    id: text("id").primaryKey(),
    extensionId: text("extension_id").references(() => extensions.id),
    // Deliberately NOT a hard FK to developers - a brand-new-developer
    // submission names a developer_id that doesn't exist yet until
    // approval. See migration 0001 (as author_id) / 0008 (renamed).
    developerId: text("developer_id").notNull(),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().default("pending"),
    payload: text("payload").notNull(),
    reviewerId: text("reviewer_id").references(() => users.id),
    reviewNote: text("review_note"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    reviewedAt: text("reviewed_at"),
    ownershipEpoch: integer("ownership_epoch").notNull().default(1),
    targetKey: text("target_key")
  },
  (table) => [
    index("idx_submissions_status").on(table.status),
    index("idx_submissions_submitted_by").on(table.submittedBy),
    index("idx_submissions_developer").on(table.developerId),
    index("idx_submissions_extension").on(table.extensionId),
    uniqueIndex("idx_extension_submissions_pending_target")
      .on(table.targetKey)
      .where(sql`${table.status} = 'pending'`),
    // created_at/id are DESC in the real index (migration 0011).
    // SQLiteColumn has no .desc() (confirmed via tsc - that's a pg-core-only
    // builder method), so the ordering is expressed as raw SQL fragments
    // instead; verified this produces "desc" in the generated SQL during
    // the baseline-diff step.
    index("idx_extension_submissions_submitter_page").on(
      table.submittedBy,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`
    ),
    index("idx_extension_submissions_queue_page").on(
      table.status,
      table.createdAt,
      table.id
    ),
    check(
      "extension_submissions_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected')`
    ),
    check(
      "extension_submissions_ownership_epoch_check",
      sql`${table.ownershipEpoch} >= 1`
    )
  ]
);

// Append-only audit log for developers writes. developer_id deliberately
// has NO FK (migration 0009 dropped it so DELETE /developers/me can hard-
// delete a developer row while the audit trail survives). The append-only
// guarantee is enforced by two triggers (trg_developer_history_no_update/
// _no_delete) that Drizzle's schema model can't express - they stay as
// hand-written SQL outside schema.ts, applied once and never touched by
// drizzle-kit's diffing.
export const developerHistory = sqliteTable(
  "developer_history",
  {
    id: text("id").primaryKey(),
    developerId: text("developer_id").notNull(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    url: text("url"),
    changedBy: text("changed_by")
      .notNull()
      .references(() => users.id),
    changedAt: text("changed_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    index("idx_developer_history_developer_changed_at").on(
      table.developerId,
      table.changedAt
    )
  ]
);

export const developerTransfers = sqliteTable(
  "developer_transfers",
  {
    id: text("id").primaryKey(),
    developerId: text("developer_id")
      .notNull()
      .references(() => developers.id),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    acceptedBy: text("accepted_by").references(() => users.id),
    acceptedAt: text("accepted_at"),
    revokedAt: text("revoked_at")
  },
  (table) => [
    uniqueIndex("idx_developer_transfers_token").on(table.tokenHash),
    // At most one active (not accepted, not revoked) transfer per developer.
    uniqueIndex("idx_developer_transfers_pending")
      .on(table.developerId)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`)
  ]
);

export const developerClaims = sqliteTable(
  "developer_claims",
  {
    id: text("id").primaryKey(),
    developerId: text("developer_id")
      .notNull()
      .references(() => developers.id),
    claimantId: text("claimant_id")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().default("pending"),
    note: text("note"),
    reviewNote: text("review_note"),
    reviewerId: text("reviewer_id").references(() => users.id),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    reviewedAt: text("reviewed_at"),
    githubOrgVerified: integer("github_org_verified"),
    githubVerificationNote: text("github_verification_note")
  },
  (table) => [
    index("idx_developer_claims_developer").on(table.developerId),
    index("idx_developer_claims_claimant").on(table.claimantId),
    // One pending claim per (developer, claimant) at a time.
    uniqueIndex("idx_developer_claims_pending_unique")
      .on(table.developerId, table.claimantId)
      .where(sql`${table.status} = 'pending'`),
    index("idx_developer_claims_pending_queue")
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    check(
      "developer_claims_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected')`
    ),
    check(
      "developer_claims_github_org_verified_check",
      sql`${table.githubOrgVerified} IN (0, 1)`
    )
  ]
);
