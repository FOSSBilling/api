-- Make the extension the resource and the review a state of it.
--
-- Before, an extension only existed once a moderator approved a submission, so
-- a developer's in-flight work lived in extension_submissions under a target id
-- reachable only through the payload JSON. After, `extensions` holds the record
-- from creation, its content columns are the published projection (NULL until
-- the first approval), and extension_submissions becomes extension_revisions:
-- one proposed content version, always attached to a real extension row.
--
-- The tables are rebuilt rather than ALTERed because SQLite cannot relax NOT
-- NULL, add a CHECK, or add a foreign key in place. Two renames ride along,
-- since the rebuild is already paid for: extensions.author_id becomes
-- developer_id, and developers' created_at/updated_at lose the placeholder 1970
-- default that migration 0002 was forced to use and no writer ever produced.
--
-- Hand-written, not drizzle-kit-generated: the generated diff cannot infer the
-- table rename or the backfills below non-interactively, so only the snapshot
-- in meta/0021_snapshot.json comes from drizzle-kit. The end state is verified
-- against schema.ts by test/services/extensions/v2/migrations.test.ts.
PRAGMA foreign_keys=OFF;--> statement-breakpoint

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
CREATE TABLE _reserved_target_check (ok INTEGER NOT NULL CHECK (ok = 1));--> statement-breakpoint

INSERT INTO _reserved_target_check (ok)
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM extension_submissions
    WHERE LOWER(COALESCE(extension_id, json_extract(payload, '$.extension.id')))
          IN ('mine')
  ) THEN 0 ELSE 1 END;--> statement-breakpoint

DROP TABLE _reserved_target_check;--> statement-breakpoint

-- developers first, while every table that references it is still the old one:
-- the drop-and-rename re-parses every schema, and doing it with a referrer
-- pointing at a dropped table is the case that errors.
CREATE TABLE `__new_developers` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`owner_user_id` text,
	`approved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`avatar_url` text,
	`contact_email` text,
	`ownership_epoch` integer DEFAULT 1 NOT NULL,
	`content_revision` integer DEFAULT 1 NOT NULL,
	`approved_revision` integer,
	`approved_by` text,
	`github_org_verified` integer,
	`github_verification_note` text,
	`github_verified_at` text,
	`github_url_verified` integer,
	`url_check_cooldown_until` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "developers_ownership_epoch_check" CHECK("__new_developers"."ownership_epoch" >= 1),
	CONSTRAINT "developers_content_revision_check" CHECK("__new_developers"."content_revision" >= 1),
	CONSTRAINT "developers_github_org_verified_check" CHECK("__new_developers"."github_org_verified" IN (0, 1)),
	CONSTRAINT "developers_github_url_verified_check" CHECK("__new_developers"."github_url_verified" = 1)
);--> statement-breakpoint

-- Existing 1970 values stay. They are wrong, but they are the only record
-- those rows have, and a timestamp invented here would look real without
-- being so.
INSERT INTO `__new_developers` (
  id, type, name, url, owner_user_id, approved_at, created_at, updated_at,
  avatar_url, contact_email, ownership_epoch, content_revision,
  approved_revision, approved_by, github_org_verified,
  github_verification_note, github_verified_at, github_url_verified,
  url_check_cooldown_until
)
SELECT
  id, type, name, url, owner_user_id, approved_at, created_at, updated_at,
  avatar_url, contact_email, ownership_epoch, content_revision,
  approved_revision, approved_by, github_org_verified,
  github_verification_note, github_verified_at, github_url_verified,
  url_check_cooldown_until
FROM `developers`;--> statement-breakpoint

DROP TABLE `developers`;--> statement-breakpoint
ALTER TABLE `__new_developers` RENAME TO `developers`;--> statement-breakpoint

CREATE UNIQUE INDEX `idx_developers_owner_unique` ON `developers` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `idx_developers_approved` ON `developers` (`approved_at`);--> statement-breakpoint

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
    FROM extension_submissions s
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
  FROM extension_submissions
) AS target
WHERE target.target_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `__new_extensions` e WHERE LOWER(e.id) = target.target_id
  )
  -- A submission whose developer no longer exists cannot produce a row that
  -- satisfies the developer_id foreign key. Dropping it here loses only an
  -- unreviewable record: the developer it was filed under is already gone.
  AND EXISTS (
    SELECT 1 FROM developers d
    WHERE d.id = (
      SELECT s.developer_id
      FROM extension_submissions s
      WHERE LOWER(COALESCE(s.extension_id, json_extract(s.payload, '$.extension.id'))) = target.target_id
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1
    )
  );--> statement-breakpoint

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
FROM extension_submissions s
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

DROP TABLE `extension_submissions`;--> statement-breakpoint

-- The rebuilds above run with foreign_keys=OFF, which means SQLite does not
-- re-validate the copied rows against the new declarations - a pre-existing
-- extension pointing at a developer that no longer exists would be carried
-- through silently, and every read would then have to defend against it
-- forever. Fail the deploy instead, and let the reads assume the join always
-- matches. Same CHECK-on-a-scratch-table trick as migration 0020, for the
-- same reason: SQLite has no RAISE() outside a trigger.
CREATE TABLE _orphan_check (ok INTEGER NOT NULL CHECK (ok = 1));--> statement-breakpoint

INSERT INTO _orphan_check (ok)
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM extensions e
    WHERE NOT EXISTS (SELECT 1 FROM developers d WHERE d.id = e.developer_id)
  ) OR EXISTS (
    SELECT 1 FROM extension_revisions r
    WHERE NOT EXISTS (SELECT 1 FROM extensions e WHERE e.id = r.extension_id)
  ) THEN 0 ELSE 1 END;--> statement-breakpoint

DROP TABLE _orphan_check;--> statement-breakpoint

PRAGMA foreign_keys=ON;
