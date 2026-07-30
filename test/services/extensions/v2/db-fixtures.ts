// Raw-SQL test fixtures against the real local D1 (see
// test/utils/apply-migrations.ts) - deliberately not going through Drizzle,
// since these exist to seed/read rows for assertions, not to exercise the
// production query layer. Row shapes are plain snake_case objects matching
// the real column names directly.

export interface DeveloperRow {
  id: string;
  type: string;
  name: string;
  url: string | null;
  owner_user_id: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  avatar_url: string | null;
  contact_email: string | null;
  ownership_epoch: number;
  content_revision: number;
  approved_revision: number | null;
  approved_by: string | null;
  github_org_verified: number | null;
  github_verification_note: string | null;
  github_verified_at: string | null;
  github_url_verified: number | null;
}

export interface ExtensionRow {
  id: string;
  type: string;
  author_id: string;
  name: string;
  description: string;
  releases: string;
  website: string;
  license: string;
  icon_url: string | null;
  readme: string;
  source: string;
  version: string;
  download_url: string;
}

export interface SubmissionRow {
  id: string;
  extension_id: string | null;
  developer_id: string;
  submitted_by: string;
  status: string;
  payload: string;
  reviewer_id: string | null;
  review_note: string | null;
  created_at: string;
  reviewed_at: string | null;
  ownership_epoch: number;
  target_key: string | null;
}

export interface DeveloperClaimRow {
  id: string;
  developer_id: string;
  claimant_id: string;
  status: string;
  note: string | null;
  review_note: string | null;
  reviewer_id: string | null;
  created_at: string;
  reviewed_at: string | null;
  github_org_verified: number | null;
  github_verification_note: string | null;
}

export interface DeveloperTransferRow {
  id: string;
  developer_id: string;
  token_hash: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
}

export interface DeveloperHistoryRow {
  id: string;
  developer_id: string;
  type: string;
  name: string;
  url: string | null;
  changed_by: string;
  changed_at: string;
}

// developer_history is genuinely append-only in production (see migrations
// 0005/0008's trg_developer_history_no_update/_no_delete triggers) - there
// is no real way to clear it that doesn't briefly drop those triggers,
// which is fine here since this only ever runs against a test-local D1,
// never anywhere the append-only guarantee actually matters.
async function clearDeveloperHistory(db: D1Database): Promise<void> {
  await db
    .prepare("DROP TRIGGER IF EXISTS trg_developer_history_no_update")
    .run();
  await db
    .prepare("DROP TRIGGER IF EXISTS trg_developer_history_no_delete")
    .run();
  await db.prepare("DELETE FROM developer_history").run();
  await db
    .prepare(
      `CREATE TRIGGER trg_developer_history_no_update
       BEFORE UPDATE ON developer_history
       BEGIN
         SELECT RAISE(ABORT, 'developer_history is append-only: rows cannot be updated');
       END`
    )
    .run();
  await db
    .prepare(
      `CREATE TRIGGER trg_developer_history_no_delete
       BEFORE DELETE ON developer_history
       BEGIN
         SELECT RAISE(ABORT, 'developer_history is append-only: rows cannot be deleted');
       END`
    )
    .run();
}

export async function resetExtensionsDb(db: D1Database): Promise<void> {
  await clearDeveloperHistory(db);
  for (const table of [
    "extension_submissions",
    "developer_transfers",
    "developer_claims",
    "extensions",
    "developers",
    "users"
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
}

export async function insertUser(
  db: D1Database,
  row: {
    id: string;
    is_moderator?: number;
    github_login?: string;
    github_orgs?: string;
  }
): Promise<void> {
  // Upsert rather than a plain INSERT: ensureUser() (called automatically
  // by the other insert* helpers below, and by authHeaders() in
  // index.test.ts, to satisfy users(id) FKs - e.g. developers.owner_user_id
  // - the same way a real caller always already has a users row by the
  // time they call this API, since auth happens first) may have already
  // created a bare stub row for this id before this richer call runs.
  await db
    .prepare(
      `INSERT INTO users (id, is_moderator, github_login, github_orgs) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         is_moderator = excluded.is_moderator,
         github_login = excluded.github_login,
         github_orgs = excluded.github_orgs`
    )
    .bind(
      row.id,
      row.is_moderator ?? null,
      row.github_login ?? null,
      row.github_orgs ?? null
    )
    .run();
}

// Satisfies a users(id) FK minimally, without clobbering a richer row
// insertUser() may set up separately (before or after this runs).
export async function ensureUser(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO users (id) VALUES (?)")
    .bind(id)
    .run();
}

export async function insertDeveloper(
  db: D1Database,
  row: Partial<DeveloperRow> & { id: string; type: string; name: string }
): Promise<void> {
  if (row.owner_user_id) {
    await ensureUser(db, row.owner_user_id);
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO developers
         (id, type, name, url, owner_user_id, approved_at, created_at, updated_at,
          avatar_url, contact_email, ownership_epoch, content_revision,
          approved_revision, approved_by, github_org_verified, github_verification_note,
          github_verified_at, github_url_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.type,
      row.name,
      row.url ?? null,
      row.owner_user_id ?? null,
      row.approved_at ?? null,
      row.created_at ?? now,
      row.updated_at ?? now,
      row.avatar_url ?? null,
      row.contact_email ?? null,
      row.ownership_epoch ?? 1,
      row.content_revision ?? 1,
      row.approved_revision ?? null,
      row.approved_by ?? null,
      row.github_org_verified ?? null,
      row.github_verification_note ?? null,
      row.github_verified_at ?? null,
      row.github_url_verified ?? null
    )
    .run();
}

export async function insertExtension(
  db: D1Database,
  row: ExtensionRow
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO extensions
         (id, type, author_id, name, description, releases, website, license,
          icon_url, readme, source, version, download_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.type,
      row.author_id,
      row.name,
      row.description,
      row.releases,
      row.website,
      row.license,
      row.icon_url ?? null,
      row.readme,
      row.source,
      row.version,
      row.download_url
    )
    .run();
}

export async function insertSubmission(
  db: D1Database,
  row: Partial<SubmissionRow> & {
    id: string;
    developer_id: string;
    submitted_by: string;
    payload: string;
  }
): Promise<void> {
  await ensureUser(db, row.submitted_by);
  if (row.reviewer_id) {
    await ensureUser(db, row.reviewer_id);
  }
  await db
    .prepare(
      `INSERT INTO extension_submissions
         (id, extension_id, developer_id, submitted_by, status, payload,
          reviewer_id, review_note, created_at, reviewed_at, ownership_epoch, target_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.extension_id ?? null,
      row.developer_id,
      row.submitted_by,
      row.status ?? "pending",
      row.payload,
      row.reviewer_id ?? null,
      row.review_note ?? null,
      row.created_at ?? new Date().toISOString(),
      row.reviewed_at ?? null,
      row.ownership_epoch ?? 1,
      row.target_key ?? null
    )
    .run();
}

export async function insertDeveloperClaim(
  db: D1Database,
  row: Partial<DeveloperClaimRow> & {
    id: string;
    developer_id: string;
    claimant_id: string;
  }
): Promise<void> {
  await ensureUser(db, row.claimant_id);
  if (row.reviewer_id) {
    await ensureUser(db, row.reviewer_id);
  }
  await db
    .prepare(
      `INSERT INTO developer_claims
         (id, developer_id, claimant_id, status, note, review_note, reviewer_id,
          created_at, reviewed_at, github_org_verified, github_verification_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.developer_id,
      row.claimant_id,
      row.status ?? "pending",
      row.note ?? null,
      row.review_note ?? null,
      row.reviewer_id ?? null,
      row.created_at ?? new Date().toISOString(),
      row.reviewed_at ?? null,
      row.github_org_verified ?? null,
      row.github_verification_note ?? null
    )
    .run();
}

export async function getDeveloper(
  db: D1Database,
  id: string
): Promise<DeveloperRow | null> {
  return db
    .prepare("SELECT * FROM developers WHERE id = ?")
    .bind(id)
    .first<DeveloperRow>();
}

export async function hasDeveloper(
  db: D1Database,
  id: string
): Promise<boolean> {
  return (await getDeveloper(db, id)) !== null;
}

export async function listDevelopers(db: D1Database): Promise<DeveloperRow[]> {
  const result = await db
    .prepare("SELECT * FROM developers")
    .all<DeveloperRow>();
  return result.results ?? [];
}

export async function countExtensions(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM extensions")
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function getExtension(
  db: D1Database,
  id: string
): Promise<ExtensionRow | null> {
  return db
    .prepare("SELECT * FROM extensions WHERE id = ?")
    .bind(id)
    .first<ExtensionRow>();
}

export async function countSubmissions(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM extension_submissions")
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function listSubmissions(
  db: D1Database
): Promise<SubmissionRow[]> {
  const result = await db
    .prepare("SELECT * FROM extension_submissions")
    .all<SubmissionRow>();
  return result.results ?? [];
}

export async function getSubmission(
  db: D1Database,
  id: string
): Promise<SubmissionRow | null> {
  return db
    .prepare("SELECT * FROM extension_submissions WHERE id = ?")
    .bind(id)
    .first<SubmissionRow>();
}

export async function countDeveloperClaims(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM developer_claims")
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function getDeveloperClaim(
  db: D1Database,
  id: string
): Promise<DeveloperClaimRow | null> {
  return db
    .prepare("SELECT * FROM developer_claims WHERE id = ?")
    .bind(id)
    .first<DeveloperClaimRow>();
}

export async function listDeveloperTransfers(
  db: D1Database
): Promise<DeveloperTransferRow[]> {
  const result = await db
    .prepare("SELECT * FROM developer_transfers")
    .all<DeveloperTransferRow>();
  return result.results ?? [];
}

export async function listDeveloperClaims(
  db: D1Database
): Promise<DeveloperClaimRow[]> {
  const result = await db
    .prepare("SELECT * FROM developer_claims")
    .all<DeveloperClaimRow>();
  return result.results ?? [];
}

export async function listDeveloperHistory(
  db: D1Database
): Promise<DeveloperHistoryRow[]> {
  const result = await db
    .prepare("SELECT * FROM developer_history")
    .all<DeveloperHistoryRow>();
  return result.results ?? [];
}

// Used by the expired-token test in place of directly mutating a stored
// row object (there's no in-memory row to mutate against real D1).
export async function expireAllDeveloperTransfers(
  db: D1Database
): Promise<void> {
  await db
    .prepare("UPDATE developer_transfers SET expires_at = ?")
    .bind("2000-01-01 00:00:00")
    .run();
}

// Used by the ownership-changes-mid-approval test: the submission's
// ownership_epoch is captured at creation time and only compared later, so
// unlike the deleteOwn/upsertOwn races, this one is a state change, not a
// mid-request timing race - a plain UPDATE before the approve() call
// reproduces it exactly.
export async function bumpDeveloperOwnership(
  db: D1Database,
  developerId: string,
  newOwnerUserId: string
): Promise<void> {
  await ensureUser(db, newOwnerUserId);
  await db
    .prepare(
      "UPDATE developers SET owner_user_id = ?, ownership_epoch = ownership_epoch + 1 WHERE id = ?"
    )
    .bind(newOwnerUserId, developerId)
    .run();
}
