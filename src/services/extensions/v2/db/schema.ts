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
// authorization and foreign-key anchor for developers, revisions, claims,
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

// An extension record exists from the moment a developer creates it, before
// any moderator has seen it. The content columns are therefore the *published*
// projection and are NULL until the first revision is approved (migration
// 0021); published_at is the marker the public catalogue filters on, and the
// CHECK below is what keeps "published" from ever meaning "half a row".
//
// The column was author_id until migration 0021. It never had to be: the only
// thing that kept the pre-v2 name was v1's public JSON field, which is called
// "author" and is produced by a mapping in v1/database.ts either way.
export const extensions = sqliteTable(
  "extensions",
  {
    id: text("id").primaryKey(),
    developerId: text("developer_id")
      .notNull()
      .references(() => developers.id),
    publishedAt: text("published_at"),
    // Which revision produced the current published content. Deliberately not
    // a FK: extension_revisions.extension_id already points the other way, and
    // a second FK between the same two tables would make them mutually
    // dependent for both inserts and the SQLite table rebuilds that migrations
    // need. NULL for rows adopted from the pre-v2 catalogue, which were never
    // published through a revision.
    publishedRevisionId: text("published_revision_id"),
    type: text("type"),
    name: text("name"),
    description: text("description"),
    releases: text("releases"),
    website: text("website"),
    license: text("license"),
    iconUrl: text("icon_url"),
    readme: text("readme"),
    source: text("source"),
    version: text("version"),
    downloadUrl: text("download_url"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    // Case-insensitive id uniqueness. The id is a lowercase slug by schema,
    // but adopted rows predate that, and this is what stops two developers
    // racing for ids that differ only in case — the job migration 0011's
    // extension_submissions.target_key index used to do from the other side.
    uniqueIndex("idx_extensions_id_nocase").on(sql`lower(${table.id})`),
    // Not partial, unlike the two below: this one serves both the public
    // developer_id filter and GET /extensions/mine, which pages every owned
    // extension and so cannot filter on published_at. A partial index would
    // leave the owner query sorting into a temporary B-tree once a developer
    // has more than one page. The public read gets its ordered seek from the
    // same index and checks published_at per row.
    index("idx_extensions_developer_order").on(
      table.developerId,
      sql`lower(${table.id})`,
      table.id
    ),
    // These two are partial: every read that uses them filters on
    // published_at IS NOT NULL, so unpublished rows would only bloat the
    // index the catalogue scans.
    index("idx_extensions_catalogue_order")
      .on(sql`lower(${table.id})`, table.id)
      .where(sql`${table.publishedAt} IS NOT NULL`),
    index("idx_extensions_type_catalogue_order")
      .on(table.type, sql`lower(${table.id})`, table.id)
      .where(sql`${table.publishedAt} IS NOT NULL`),
    // "Published" must mean every column the public contract declares
    // non-optional is present. icon_url is genuinely optional and is left out.
    check(
      "extensions_published_content_check",
      sql`${table.publishedAt} IS NULL OR (
        ${table.type} IS NOT NULL AND ${table.name} IS NOT NULL AND
        ${table.description} IS NOT NULL AND ${table.releases} IS NOT NULL AND
        ${table.website} IS NOT NULL AND ${table.license} IS NOT NULL AND
        ${table.readme} IS NOT NULL AND ${table.source} IS NOT NULL AND
        ${table.version} IS NOT NULL AND ${table.downloadUrl} IS NOT NULL
      )`
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
    // ALTER TABLE ADD COLUMN defaults). Every write sets this explicitly (see
    // db/developer-profiles.ts) - the literal default is never actually read,
    // but it is part of the real column definition, so it is kept here for
    // baseline-diff fidelity against the existing database.
    //
    // Replacing it needs a table rebuild, and this table cannot be rebuilt on
    // D1: developer_claims, developer_transfers and extensions all reference
    // it, D1 does not allow foreign keys to be switched off, and deferring
    // them is not equivalent - DROP TABLE on a parent increments SQLite's
    // deferred-violation counter for every child row, renaming the replacement
    // into place never decrements it, and COMMIT then fails even though the
    // data is consistent. Doing it anyway would mean rebuilding all three
    // children too, which is a lot of risk for a default nothing reads.
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
    // see DeveloperProfilesDatabase.reverifyOwn(). Left null/stale on an
    // inconclusive check (no linked GitHub identity), same as
    // githubOrgVerified itself.
    githubVerifiedAt: text("github_verified_at"),
    // Whether `url` matches GitHub's own on-file website — see
    // github/verification.ts's urlMatchesGithubBlog(). Only ever 1 or null,
    // never 0 (see the schema comment on schemas/developers.ts's
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
    // 1 or NULL, never 0 (see schemas/developers.ts's DeveloperProfileSchema
    // comment) — SQLite's CHECK already treats NULL as satisfying `= 1`, so
    // this enforces that invariant instead of just validating it's a 0/1.
    check(
      "developers_github_url_verified_check",
      sql`${table.githubUrlVerified} = 1`
    )
  ]
);

// A proposed version of one extension's content, awaiting or carrying a
// moderator decision. Renamed from extension_submissions by migration 0021,
// which also made extension_id NOT NULL: an extension row now exists before
// its first revision does, so a revision no longer has to name its target
// indirectly through the payload. `content` is the extension content only —
// developer edits go through PUT /developers/me and are no longer smuggled
// through the review queue.
export const extensionRevisions = sqliteTable(
  "extension_revisions",
  {
    id: text("id").primaryKey(),
    extensionId: text("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    // Which developer the revision was proposed under, kept as an audit fact
    // even after the extension is transferred. Deliberately NOT a FK, so
    // DELETE /developers/me can hard-delete a profile without erasing the
    // review record (same reasoning as developer_history — migration 0009).
    developerId: text("developer_id").notNull(),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().default("pending"),
    content: text("content").notNull(),
    reviewerId: text("reviewer_id").references(() => users.id),
    reviewNote: text("review_note"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    reviewedAt: text("reviewed_at"),
    ownershipEpoch: integer("ownership_epoch").notNull().default(1)
  },
  (table) => [
    index("idx_extension_revisions_submitted_by").on(table.submittedBy),
    index("idx_extension_revisions_developer").on(table.developerId),
    // At most one unreviewed revision per extension. This replaces migration
    // 0011's target_key index: the target is now a real column, so the
    // constraint no longer depends on a denormalised copy of an id that also
    // lived inside the payload JSON.
    uniqueIndex("idx_extension_revisions_pending")
      .on(table.extensionId)
      .where(sql`${table.status} = 'pending'`),
    // created_at/id are DESC in the real index. SQLiteColumn has no .desc()
    // (confirmed via tsc - that's a pg-core-only builder method), so the
    // ordering is expressed as raw SQL fragments instead.
    index("idx_extension_revisions_extension_page").on(
      table.extensionId,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`
    ),
    index("idx_extension_revisions_submitter_page").on(
      table.submittedBy,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`
    ),
    index("idx_extension_revisions_queue_page").on(
      table.status,
      table.createdAt,
      table.id
    ),
    check(
      "extension_revisions_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected')`
    ),
    check(
      "extension_revisions_ownership_epoch_check",
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
