-- Make the extension the resource and the review a state of it.
--
-- Before, an extension only existed once a moderator approved a submission, so
-- a developer's in-flight work lived in extension_submissions under a target id
-- reachable only through the payload JSON. After, `extensions` holds the record
-- from creation, its content columns are the published projection (NULL until
-- the first approval), and extension_submissions becomes extension_revisions:
-- one proposed content version, always attached to a real extension row.
--
-- extensions is rebuilt rather than ALTERed because SQLite cannot relax NOT
-- NULL, add a CHECK, or add a foreign key in place. author_id becomes
-- developer_id on the way through, since the rebuild is already paid for.
--
-- Hand-written, not drizzle-kit-generated: the generated diff cannot infer the
-- table rename or the backfills below non-interactively, so only the snapshot
-- in meta/0021_snapshot.json comes from drizzle-kit. The end state is verified
-- against schema.ts by test/services/extensions/v2/migrations.test.ts.
--
-- The ordering below is load-bearing: nothing here drops a table that still
-- has children, which is why extension_submissions is copied aside and dropped
-- before extensions is rebuilt. Neither pragma can buy you out of this.
-- foreign_keys=OFF is a no-op inside a transaction, and wrangler wraps each
-- migration file in one - an earlier version of this file opened with it,
-- passed locally where statements run outside a transaction, and failed the
-- first remote apply. defer_foreign_keys is not a substitute either: DROP
-- TABLE on a parent increments SQLite's deferred-violation counter once per
-- child row and nothing ever decrements it, so COMMIT fails even when
-- foreign_key_check is clean. It is also why developers is not rebuilt here -
-- three tables reference it. See migrations.test.ts's applyAllAsD1().

-- idx_extensions_id_nocase, created further down, is the constraint that stops
-- a new lowercase id colliding with an adopted mixed-case one. A catalogue
-- adopted from v1 predates it and may already hold such a pair, in which case
-- CREATE UNIQUE INDEX would abort the migration halfway through the rebuild.
--
-- This and the two checks that follow are written the same way: select the
-- offending rows into a scratch table whose CHECK can never hold, so a clean
-- database inserts nothing and passes, and a dirty one fails with the
-- constraint's name as the message. SQLite has no RAISE() outside a trigger,
-- so the constraint name is the only place a diagnosis can be put.
--
-- These duplicates are not reconciled automatically. Both ids are public, and
-- the pair is already ambiguous to every reader - v1 and v2 both resolve ids
-- with LOWER(), so one of the two rows is currently unreachable depending on
-- which the query happens to return first. Choosing which one survives, and
-- whether the other is renamed or removed, is a decision about published data
-- that belongs to a human. Run the query in the INSERT below to list them.
CREATE TABLE _extension_id_case_conflicts (
  lowercased_id TEXT NOT NULL,
  copies INTEGER NOT NULL,
  CONSTRAINT extension_ids_must_not_differ_only_by_case CHECK (copies = 0)
);--> statement-breakpoint

INSERT INTO _extension_id_case_conflicts (lowercased_id, copies)
SELECT LOWER(id), COUNT(*) FROM extensions
GROUP BY LOWER(id) HAVING COUNT(*) > 1;--> statement-breakpoint

DROP TABLE _extension_id_case_conflicts;--> statement-breakpoint

-- A dangling developer reference would be caught by the real foreign key on
-- the rebuilt table, but as a bare "FOREIGN KEY constraint failed" from the
-- middle of the copy. Check it here, before anything is copied, so the failure
-- names what is wrong and points at the rows.
CREATE TABLE _unresolved_references (
  kind TEXT NOT NULL,
  row_id TEXT NOT NULL,
  CONSTRAINT extension_references_must_resolve CHECK (1 = 0)
);--> statement-breakpoint

INSERT INTO _unresolved_references (kind, row_id)
SELECT 'extension.developer_id', e.id FROM extensions e
WHERE NOT EXISTS (SELECT 1 FROM developers d WHERE d.id = e.author_id);--> statement-breakpoint

DROP TABLE _unresolved_references;--> statement-breakpoint

-- A submission naming a developer that does not exist cannot become an
-- extension row: developer_id is NOT NULL with a foreign key. Such a
-- submission is already unapprovable today - the pre-0021 approve() only ever
-- UPDATEs a developer, never inserts one, so it would mark the submission
-- approved and publish nothing - but dropping the row here would lose that
-- record silently, which is not a migration's decision to make.
--
-- The developer is deliberately NOT backfilled from payload.developer.
-- Creating a profile would mint an ownership grant that no moderator ever
-- approved, which is the exact thing the claim and approval flows exist to
-- prevent. Create the developer deliberately, or delete the submission, then
-- re-run.
CREATE TABLE _submissions_without_a_developer (
  submission_id TEXT NOT NULL,
  missing_developer_id TEXT NOT NULL,
  CONSTRAINT submissions_must_name_an_existing_developer CHECK (1 = 0)
);--> statement-breakpoint

INSERT INTO _submissions_without_a_developer (submission_id, missing_developer_id)
SELECT s.id, s.developer_id
FROM extension_submissions s
WHERE NOT EXISTS (SELECT 1 FROM developers d WHERE d.id = s.developer_id)
  AND NOT EXISTS (
    SELECT 1 FROM extensions e
    WHERE LOWER(e.id) = LOWER(COALESCE(s.extension_id, json_extract(s.payload, '$.extension.id')))
  );--> statement-breakpoint

DROP TABLE _submissions_without_a_developer;--> statement-breakpoint

-- A submission whose target id is reserved would materialise an extension
-- that GET /extensions/{id} can never serve, because the static
-- GET /extensions/mine route is registered first. The old code rejected these
-- at submission time and again at approval; with approval no longer looking at
-- the id, the check has to happen here, before the row exists.
--
-- This fails the deploy rather than dropping the submission, matching
-- migration 0020. If it fires, reject or delete the offending row by hand and
-- re-run - unlike 0020's case the id is not yet public, so nothing pins it and
-- there is nothing to preserve. Comparison is on the lowercased target because
-- that is what the materialisation below would insert.
CREATE TABLE _reserved_submission_targets (
  submission_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  CONSTRAINT submission_target_ids_must_not_be_reserved CHECK (1 = 0)
);--> statement-breakpoint

INSERT INTO _reserved_submission_targets (submission_id, target_id)
SELECT
  id,
  LOWER(COALESCE(extension_id, json_extract(payload, '$.extension.id')))
FROM extension_submissions
WHERE LOWER(COALESCE(extension_id, json_extract(payload, '$.extension.id')))
      IN ('mine');--> statement-breakpoint

DROP TABLE _reserved_submission_targets;--> statement-breakpoint

-- extension_submissions is the only table referencing extensions, so it goes
-- first. AS SELECT rather than a declared table: it carries no constraints
-- across, so the holding table survives the rebuild it spans.
CREATE TABLE `_submissions_backup` AS SELECT * FROM `extension_submissions`;--> statement-breakpoint

DROP TABLE `extension_submissions`;--> statement-breakpoint

CREATE TABLE `__new_extensions` (
	`id` text PRIMARY KEY NOT NULL,
	`developer_id` text NOT NULL,
	`published_at` text,
	`published_revision_id` text,
	`type` text,
	`name` text,
	`description` text,
	`releases` text,
	`website` text,
	`license` text,
	`icon_url` text,
	`readme` text,
	`source` text,
	`version` text,
	`download_url` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`developer_id`) REFERENCES `developers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "extensions_published_content_check" CHECK("__new_extensions"."published_at" IS NULL OR (
        "__new_extensions"."type" IS NOT NULL AND "__new_extensions"."name" IS NOT NULL AND
        "__new_extensions"."description" IS NOT NULL AND "__new_extensions"."releases" IS NOT NULL AND
        "__new_extensions"."website" IS NOT NULL AND "__new_extensions"."license" IS NOT NULL AND
        "__new_extensions"."readme" IS NOT NULL AND "__new_extensions"."source" IS NOT NULL AND
        "__new_extensions"."version" IS NOT NULL AND "__new_extensions"."download_url" IS NOT NULL
      ))
);--> statement-breakpoint

-- Every row that existed before this migration is, by definition, live in the
-- public catalogue, so it is published. published_revision_id stays NULL:
-- these rows were adopted or approved before revisions were addressable, and
-- inventing a revision id for them would fabricate a review that never
-- happened.
INSERT INTO `__new_extensions` (
  id, developer_id, published_at, published_revision_id, type, name, description,
  releases, website, license, icon_url, readme, source, version, download_url,
  created_at, updated_at
)
SELECT
  id, author_id, CURRENT_TIMESTAMP, NULL, type, name, description,
  releases, website, license, icon_url, readme, source, version, download_url,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM `extensions`;--> statement-breakpoint

-- Materialise the extension record every existing submission was targeting.
-- A submission that named an extension row already covered above is skipped;
-- one that proposed a brand-new id becomes an unpublished extension owned by
-- the developer the submission named. Rejected submissions get a row too: an
-- unpublished extension whose only revision was rejected is a real state the
-- owner can see and resubmit from, and it keeps the FK below total.
--
-- Ties on a target id are resolved by newest submission, matching the pending
-- unique index that only ever allowed one live claim on it.
INSERT INTO `__new_extensions` (id, developer_id, published_at, created_at, updated_at)
SELECT
  target.target_id,
  (
    SELECT s.developer_id
    FROM _submissions_backup s
    WHERE LOWER(COALESCE(s.extension_id, json_extract(s.payload, '$.extension.id'))) = target.target_id
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT 1
  ),
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT
    LOWER(COALESCE(extension_id, json_extract(payload, '$.extension.id'))) AS target_id
  FROM _submissions_backup
) AS target
WHERE target.target_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `__new_extensions` e WHERE LOWER(e.id) = target.target_id
  )
  ;--> statement-breakpoint

DROP TABLE `extensions`;--> statement-breakpoint
ALTER TABLE `__new_extensions` RENAME TO `extensions`;--> statement-breakpoint

CREATE UNIQUE INDEX `idx_extensions_id_nocase` ON `extensions` (lower("id"));--> statement-breakpoint
CREATE INDEX `idx_extensions_developer_order` ON `extensions` (`developer_id`,lower("id"),`id`);--> statement-breakpoint
CREATE INDEX `idx_extensions_catalogue_order` ON `extensions` (lower("id"),`id`) WHERE "extensions"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_extensions_type_catalogue_order` ON `extensions` (`type`,lower("id"),`id`) WHERE "extensions"."published_at" IS NOT NULL;--> statement-breakpoint

CREATE TABLE `extension_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`extension_id` text NOT NULL,
	`developer_id` text NOT NULL,
	`submitted_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`content` text NOT NULL,
	`reviewer_id` text,
	`review_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`reviewed_at` text,
	`ownership_epoch` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "extension_revisions_status_check" CHECK("extension_revisions"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "extension_revisions_ownership_epoch_check" CHECK("extension_revisions"."ownership_epoch" >= 1)
);--> statement-breakpoint

-- payload was {developer, extension}; content is the extension half alone,
-- minus its id. The developer half is dropped on purpose: approving an
-- extension used to rewrite the developer profile and reset its approval as a
-- side effect. Developer edits are PUT /developers/me's job and always were.
-- The id moves out because it is now the extension row's identity rather than
-- a field a revision proposes; an extension cannot be renamed by an edit.
--
-- extension_id is resolved through the new extensions table so it matches the
-- row this migration just materialised, including when the submission's
-- proposed id differed from it only in case.
INSERT INTO `extension_revisions` (
  id, extension_id, developer_id, submitted_by, status, content, reviewer_id,
  review_note, created_at, reviewed_at, ownership_epoch
)
SELECT
  s.id,
  e.id,
  s.developer_id,
  s.submitted_by,
  s.status,
  json_remove(json_extract(s.payload, '$.extension'), '$.id'),
  s.reviewer_id,
  s.review_note,
  s.created_at,
  s.reviewed_at,
  s.ownership_epoch
FROM _submissions_backup s
JOIN extensions e
  ON LOWER(e.id) = LOWER(COALESCE(s.extension_id, json_extract(s.payload, '$.extension.id')))
-- A payload without an extension object cannot become a revision. This has
-- never been writable through the API: SubmissionPayloadSchema required it.
WHERE json_extract(s.payload, '$.extension') IS NOT NULL;--> statement-breakpoint

-- A pending revision is only approvable if its developer still exists, still
-- belongs to the submitter, still has the ownership epoch the revision was
-- filed under, and is still the extension's developer - that is exactly the
-- EXISTS predicate in ExtensionRevisionsDatabase.approve(). Legacy rows that
-- fail it can never be approved, and because at most one revision per
-- extension may be pending they would also block the owner's next edit
-- indefinitely.
--
-- Rejecting rather than deleting keeps the record and frees the slot, and uses
-- the same note the transfer and account-deletion paths already write when
-- they invalidate pending work.
UPDATE extension_revisions
SET status = 'rejected',
    review_note = 'Ownership changed before review',
    reviewed_at = CURRENT_TIMESTAMP
WHERE status = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM developers d
    JOIN extensions e ON e.id = extension_revisions.extension_id
    WHERE d.id = extension_revisions.developer_id
      AND d.id = e.developer_id
      AND d.owner_user_id = extension_revisions.submitted_by
      AND d.ownership_epoch = extension_revisions.ownership_epoch
  );--> statement-breakpoint

CREATE INDEX `idx_extension_revisions_submitted_by` ON `extension_revisions` (`submitted_by`);--> statement-breakpoint
CREATE INDEX `idx_extension_revisions_developer` ON `extension_revisions` (`developer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_extension_revisions_pending` ON `extension_revisions` (`extension_id`) WHERE "extension_revisions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `idx_extension_revisions_extension_page` ON `extension_revisions` (`extension_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `idx_extension_revisions_submitter_page` ON `extension_revisions` (`submitted_by`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `idx_extension_revisions_queue_page` ON `extension_revisions` (`status`,`created_at`,`id`);--> statement-breakpoint

DROP TABLE `_submissions_backup`;--> statement-breakpoint
