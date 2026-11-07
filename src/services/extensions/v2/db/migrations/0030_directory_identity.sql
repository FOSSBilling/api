-- Keep directory identities independent from public identifiers.
-- Rebuild children before parents so D1 can enforce foreign keys throughout.
CREATE TABLE _developers_ids AS SELECT id AS identifier,
 substr(timestamp,1,8)||'-'||substr(timestamp,9,4)||'-7'||substr(entropy,1,3)||'-'||substr('89ab',1+(abs(random() % 4)),1)||substr(entropy,4,3)||'-'||substr(entropy,7,12) AS id
 FROM (SELECT id,printf('%012x',CAST(unixepoch(created_at)*1000 AS INTEGER)) AS timestamp,lower(hex(randomblob(9))) AS entropy FROM (
   SELECT id,created_at FROM developers
   UNION ALL
   SELECT developer_id, min(changed_at) FROM developer_history
   WHERE developer_id NOT IN (SELECT id FROM developers) GROUP BY developer_id
 ));
--> statement-breakpoint
CREATE TABLE _extensions_ids AS SELECT id AS identifier,
 substr(timestamp,1,8)||'-'||substr(timestamp,9,4)||'-7'||substr(entropy,1,3)||'-'||substr('89ab',1+(abs(random() % 4)),1)||substr(entropy,4,3)||'-'||substr(entropy,7,12) AS id
 FROM (SELECT id,printf('%012x',CAST(unixepoch(created_at)*1000 AS INTEGER)) AS timestamp,lower(hex(randomblob(9))) AS entropy FROM extensions);
--> statement-breakpoint
CREATE TABLE _developers_backup AS SELECT rowid AS original_rowid,* FROM developers;
--> statement-breakpoint
CREATE TABLE _extensions_backup AS SELECT rowid AS original_rowid,* FROM extensions;
--> statement-breakpoint
CREATE TABLE _developer_transfers_backup AS SELECT rowid AS original_rowid,* FROM developer_transfers;
--> statement-breakpoint
CREATE TABLE _developer_claims_backup AS SELECT rowid AS original_rowid,* FROM developer_claims;
--> statement-breakpoint
CREATE TABLE _developer_history_backup AS SELECT rowid AS original_rowid,* FROM developer_history;
--> statement-breakpoint
CREATE TABLE _extension_write_events_backup AS SELECT rowid AS original_rowid,* FROM extension_write_events;
--> statement-breakpoint
CREATE TABLE _m2m_publisher_clients_backup AS SELECT rowid AS original_rowid,* FROM m2m_publisher_clients;
--> statement-breakpoint
CREATE TABLE _extension_revisions_backup AS SELECT rowid AS original_rowid,* FROM extension_revisions;
--> statement-breakpoint
DROP TRIGGER trg_developer_history_no_update;
--> statement-breakpoint
DROP TRIGGER trg_developer_history_no_delete;
--> statement-breakpoint
DROP TRIGGER resource_extension_revisions_insert;
--> statement-breakpoint
DROP TRIGGER resource_extension_revisions_delete;
--> statement-breakpoint
DROP TRIGGER resource_extension_revisions_update;
--> statement-breakpoint
DROP TRIGGER resource_extension_revisions_identity_update;
--> statement-breakpoint
DROP TRIGGER extension_revision_admission;
--> statement-breakpoint
DROP TRIGGER extension_revision_write_event;
--> statement-breakpoint
DROP TRIGGER extension_revision_content_bound;
--> statement-breakpoint
DROP TRIGGER extension_revision_identity;
--> statement-breakpoint
DROP TRIGGER extension_resource_identity;
--> statement-breakpoint
DROP TRIGGER sync_extension_revisions_bytes_insert;
--> statement-breakpoint
DROP TRIGGER sync_extension_revisions_bytes_update;
--> statement-breakpoint
DROP TRIGGER sync_revision_summary_insert;
--> statement-breakpoint
DROP TRIGGER sync_revision_summary_update;
--> statement-breakpoint
DROP TRIGGER developers_generate_profile_instance;
--> statement-breakpoint
DROP TRIGGER resource_extensions_insert;
--> statement-breakpoint
DROP TRIGGER sync_extensions_bytes_insert;
--> statement-breakpoint
DROP TRIGGER sync_extensions_bytes_update;
--> statement-breakpoint
DROP TRIGGER resource_extensions_delete;
--> statement-breakpoint
DROP TRIGGER resource_extensions_update;
--> statement-breakpoint
DROP TRIGGER extensions_published_manifest_insert;
--> statement-breakpoint
DROP TRIGGER extensions_published_manifest_update;
--> statement-breakpoint
DROP TABLE extension_revisions;
--> statement-breakpoint
DROP TABLE m2m_publisher_clients;
--> statement-breakpoint
DROP TABLE extension_write_events;
--> statement-breakpoint
DROP TABLE developer_history;
--> statement-breakpoint
DROP TABLE developer_claims;
--> statement-breakpoint
DROP TABLE developer_transfers;
--> statement-breakpoint
DROP TABLE extensions;
--> statement-breakpoint
DROP TABLE developers;
--> statement-breakpoint
CREATE TABLE "developers" (
  id   TEXT PRIMARY KEY NOT NULL,
 identifier text NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  url  TEXT
, owner_user_id TEXT REFERENCES users(id), approved_at TEXT, created_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z', updated_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z', avatar_url    TEXT, contact_email TEXT, ownership_epoch INTEGER NOT NULL DEFAULT 1 CHECK (ownership_epoch >= 1), content_revision INTEGER NOT NULL DEFAULT 1 CHECK (content_revision >= 1), approved_revision INTEGER, approved_by TEXT, github_org_verified INTEGER CHECK (github_org_verified IN (0, 1)), github_verification_note TEXT, `github_verified_at` text, github_url_verified INTEGER CHECK (github_url_verified = 1), `url_check_cooldown_until` text, `profile_generation` text DEFAULT '' NOT NULL);
--> statement-breakpoint
CREATE TABLE "extensions" (
	`id` text PRIMARY KEY NOT NULL,
 identifier text NOT NULL,
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
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `delisted_at` text, `delist_reason` text, created_by TEXT, published_bytes INTEGER NOT NULL DEFAULT 0, manifest TEXT,
	FOREIGN KEY (`developer_id`) REFERENCES `developers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "extensions_published_content_check" CHECK("extensions"."published_at" IS NULL OR (
        "extensions"."type" IS NOT NULL AND "extensions"."name" IS NOT NULL AND
        "extensions"."description" IS NOT NULL AND "extensions"."releases" IS NOT NULL AND
        "extensions"."website" IS NOT NULL AND "extensions"."license" IS NOT NULL AND
        "extensions"."readme" IS NOT NULL AND "extensions"."source" IS NOT NULL AND
        "extensions"."version" IS NOT NULL AND "extensions"."download_url" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "developer_transfers" (
  id          TEXT PRIMARY KEY NOT NULL,
  developer_id   TEXT NOT NULL REFERENCES "developers"(id),
  token_hash  TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  TEXT NOT NULL,
  accepted_by TEXT REFERENCES users(id),
  accepted_at TEXT,
  revoked_at  TEXT
);
--> statement-breakpoint
CREATE TABLE "developer_claims" (
  id          TEXT PRIMARY KEY NOT NULL,
  developer_id   TEXT NOT NULL REFERENCES "developers"(id),
  claimant_id TEXT NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  note        TEXT,
  review_note TEXT,
  reviewer_id TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
, github_org_verified INTEGER CHECK (github_org_verified IN (0, 1)), github_verification_note TEXT);
--> statement-breakpoint
CREATE TABLE "developer_history" (
  id           TEXT PRIMARY KEY NOT NULL,
  developer_id TEXT NOT NULL,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  url          TEXT,
  changed_by   TEXT NOT NULL REFERENCES users(id),
  changed_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE extension_write_events (
  id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL,
  developer_id TEXT NOT NULL, occurred_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE `m2m_publisher_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`developer_id` text NOT NULL,
	`can_publish` integer DEFAULT 0 NOT NULL,
	`ownership_epoch` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`developer_id`) REFERENCES `developers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "m2m_publisher_clients_can_publish_check" CHECK("m2m_publisher_clients"."can_publish" IN (0, 1)),
	CONSTRAINT "m2m_publisher_clients_ownership_epoch_check" CHECK("m2m_publisher_clients"."ownership_epoch" >= 1)
);
--> statement-breakpoint
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
	`ownership_epoch` integer DEFAULT 1 NOT NULL, content_bytes INTEGER NOT NULL DEFAULT 0, content_hash TEXT, compacted_at TEXT, summary_name TEXT, summary_version TEXT, summary_description TEXT, content_readable INTEGER NOT NULL DEFAULT 0,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "extension_revisions_status_check" CHECK("extension_revisions"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "extension_revisions_ownership_epoch_check" CHECK("extension_revisions"."ownership_epoch" >= 1)
);
--> statement-breakpoint
INSERT INTO developers (id,type,name,url,owner_user_id,approved_at,created_at,updated_at,avatar_url,contact_email,ownership_epoch,content_revision,approved_revision,approved_by,github_org_verified,github_verification_note,github_verified_at,github_url_verified,url_check_cooldown_until,profile_generation,identifier)
 SELECT (SELECT id FROM _developers_ids WHERE identifier=b.id),b.type,b.name,b.url,b.owner_user_id,b.approved_at,b.created_at,b.updated_at,b.avatar_url,b.contact_email,b.ownership_epoch,b.content_revision,b.approved_revision,b.approved_by,b.github_org_verified,b.github_verification_note,b.github_verified_at,b.github_url_verified,b.url_check_cooldown_until,b.profile_generation,b.id
 FROM _developers_backup b ORDER BY original_rowid;
--> statement-breakpoint
INSERT INTO extensions (id,developer_id,published_at,published_revision_id,type,name,description,releases,website,license,icon_url,readme,source,version,download_url,created_at,updated_at,delisted_at,delist_reason,created_by,published_bytes,manifest,identifier)
 SELECT (SELECT id FROM _extensions_ids WHERE identifier=b.id),coalesce((SELECT id FROM _developers_ids WHERE identifier=b.developer_id),b.developer_id),b.published_at,b.published_revision_id,b.type,b.name,b.description,b.releases,b.website,b.license,b.icon_url,b.readme,b.source,b.version,b.download_url,b.created_at,b.updated_at,b.delisted_at,b.delist_reason,b.created_by,b.published_bytes,b.manifest,b.id
 FROM _extensions_backup b ORDER BY original_rowid;
--> statement-breakpoint
INSERT INTO developer_transfers (id,developer_id,token_hash,created_by,created_at,expires_at,accepted_by,accepted_at,revoked_at)
 SELECT b.id,coalesce((SELECT id FROM _developers_ids WHERE identifier=b.developer_id),b.developer_id),b.token_hash,b.created_by,b.created_at,b.expires_at,b.accepted_by,b.accepted_at,b.revoked_at
 FROM _developer_transfers_backup b ORDER BY original_rowid;
--> statement-breakpoint
INSERT INTO developer_claims (id,developer_id,claimant_id,status,note,review_note,reviewer_id,created_at,reviewed_at,github_org_verified,github_verification_note)
 SELECT b.id,coalesce((SELECT id FROM _developers_ids WHERE identifier=b.developer_id),b.developer_id),b.claimant_id,b.status,b.note,b.review_note,b.reviewer_id,b.created_at,b.reviewed_at,b.github_org_verified,b.github_verification_note
 FROM _developer_claims_backup b ORDER BY original_rowid;
--> statement-breakpoint
INSERT INTO developer_history (id,developer_id,type,name,url,changed_by,changed_at)
 SELECT b.id,coalesce((SELECT id FROM _developers_ids WHERE identifier=b.developer_id),b.developer_id),b.type,b.name,b.url,b.changed_by,b.changed_at
 FROM _developer_history_backup b ORDER BY original_rowid;
--> statement-breakpoint
INSERT INTO extension_write_events (id,account_id,developer_id,occurred_at)
 SELECT b.id,b.account_id,coalesce((SELECT id FROM _developers_ids WHERE identifier=b.developer_id),b.developer_id),b.occurred_at
 FROM _extension_write_events_backup b ORDER BY original_rowid;
--> statement-breakpoint
INSERT INTO m2m_publisher_clients (client_id,developer_id,can_publish,ownership_epoch,created_at,revoked_at)
 SELECT b.client_id,coalesce((SELECT id FROM _developers_ids WHERE identifier=b.developer_id),b.developer_id),b.can_publish,b.ownership_epoch,b.created_at,b.revoked_at
 FROM _m2m_publisher_clients_backup b ORDER BY original_rowid;
--> statement-breakpoint
INSERT INTO extension_revisions (id,extension_id,developer_id,submitted_by,status,content,reviewer_id,review_note,created_at,reviewed_at,ownership_epoch,content_bytes,content_hash,compacted_at,summary_name,summary_version,summary_description,content_readable)
 SELECT b.id,(SELECT id FROM _extensions_ids WHERE identifier=b.extension_id),coalesce((SELECT id FROM _developers_ids WHERE identifier=b.developer_id),b.developer_id),b.submitted_by,b.status,b.content,b.reviewer_id,b.review_note,b.created_at,b.reviewed_at,b.ownership_epoch,b.content_bytes,b.content_hash,b.compacted_at,b.summary_name,b.summary_version,b.summary_description,b.content_readable
 FROM _extension_revisions_backup b ORDER BY original_rowid;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_developers_owner_unique ON developers(owner_user_id);
--> statement-breakpoint
CREATE INDEX idx_developers_approved ON developers(approved_at);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_developer_transfers_token ON developer_transfers(token_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_developer_transfers_pending
  ON developer_transfers(developer_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX idx_developer_claims_developer ON developer_claims(developer_id);
--> statement-breakpoint
CREATE INDEX idx_developer_claims_claimant ON developer_claims(claimant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_developer_claims_pending_unique
  ON developer_claims(developer_id, claimant_id)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX idx_developer_claims_pending_queue
  ON developer_claims(created_at)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX idx_developer_history_developer_changed_at
  ON developer_history(developer_id, changed_at);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_extensions_identifier_nocase` ON `extensions` (lower("identifier"));
--> statement-breakpoint
CREATE INDEX `idx_extensions_developer_order` ON `extensions` (`developer_id`,lower("identifier"),`id`);
--> statement-breakpoint
CREATE INDEX `idx_extension_revisions_submitted_by` ON `extension_revisions` (`submitted_by`);
--> statement-breakpoint
CREATE INDEX `idx_extension_revisions_developer` ON `extension_revisions` (`developer_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_extension_revisions_pending` ON `extension_revisions` (`extension_id`) WHERE "extension_revisions"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX `idx_extension_revisions_extension_page` ON `extension_revisions` (`extension_id`,"created_at" desc,"id" desc);
--> statement-breakpoint
CREATE INDEX `idx_extension_revisions_submitter_page` ON `extension_revisions` (`submitted_by`,"created_at" desc,"id" desc);
--> statement-breakpoint
CREATE INDEX `idx_extension_revisions_queue_page` ON `extension_revisions` (`status`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_extension_revisions_reviewed` ON `extension_revisions` (`extension_id`,`reviewed_at`) WHERE "extension_revisions"."status" IN ('approved', 'rejected');
--> statement-breakpoint
CREATE INDEX `idx_extension_revisions_submitter_pending` ON `extension_revisions` (`submitted_by`) WHERE "extension_revisions"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX `idx_developer_history_account_changed_at` ON `developer_history` (`changed_by`,`changed_at`);
--> statement-breakpoint
CREATE INDEX idx_extension_write_events_account ON extension_write_events(account_id,occurred_at);
--> statement-breakpoint
CREATE INDEX idx_extension_write_events_developer ON extension_write_events(developer_id,occurred_at);
--> statement-breakpoint
CREATE INDEX idx_extension_write_events_time ON extension_write_events(occurred_at);
--> statement-breakpoint
CREATE INDEX idx_extensions_published_revision ON extensions(published_revision_id);
--> statement-breakpoint
CREATE INDEX idx_extension_revisions_retention ON extension_revisions(compacted_at,reviewed_at,id,status);
--> statement-breakpoint
CREATE INDEX `idx_m2m_publisher_clients_developer` ON `m2m_publisher_clients` (`developer_id`);
--> statement-breakpoint
CREATE INDEX idx_extensions_public_order ON extensions (lower(identifier),id) WHERE published_at IS NOT NULL AND delisted_at IS NULL;
--> statement-breakpoint
CREATE INDEX idx_extensions_type_public_order ON extensions (type,lower(identifier),id) WHERE published_at IS NOT NULL AND delisted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_developers_identifier_nocase ON developers(lower(identifier));
--> statement-breakpoint
CREATE TRIGGER trg_developer_history_no_update
BEFORE UPDATE ON developer_history
BEGIN
  SELECT RAISE(ABORT, 'developer_history is append-only: rows cannot be updated');
END;
--> statement-breakpoint
CREATE TRIGGER trg_developer_history_no_delete
BEFORE DELETE ON developer_history
BEGIN
  SELECT RAISE(ABORT, 'developer_history is append-only: rows cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER resource_extension_revisions_insert AFTER INSERT ON extension_revisions BEGIN
  INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions)
  SELECT scope, subject, length(CAST(NEW.content AS BLOB)), 0, 1
  FROM (
    SELECT 'global' AS scope, 'all' AS subject
    UNION ALL SELECT 'account', NEW.submitted_by
    UNION ALL SELECT 'developer', NEW.developer_id
  ) WHERE true
  ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes,
    extensions=extensions+excluded.extensions,
    revisions=revisions+excluded.revisions;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM extension_resource_usage
    WHERE ((scope='account' AND subject=NEW.submitted_by)
        OR (scope='developer' AND subject=NEW.developer_id))
      AND (bytes>26214400 OR extensions>100 OR revisions>1000)
  ) THEN RAISE(ABORT,'extension_resource_quota') END;
END;
--> statement-breakpoint
CREATE TRIGGER resource_extension_revisions_delete AFTER DELETE ON extension_revisions BEGIN
  UPDATE extension_resource_usage
  SET bytes=bytes-(length(CAST(OLD.content AS BLOB))), revisions=revisions-1
  WHERE (scope='global' AND subject='all')
     OR (scope='account' AND subject=OLD.submitted_by)
     OR (scope='developer' AND subject=OLD.developer_id);
END;
--> statement-breakpoint
CREATE TRIGGER resource_extension_revisions_update AFTER UPDATE OF content ON extension_revisions
WHEN NEW.submitted_by=OLD.submitted_by AND NEW.developer_id=OLD.developer_id BEGIN
  UPDATE extension_resource_usage
  SET bytes = bytes + length(CAST(NEW.content AS BLOB)) - length(CAST(OLD.content AS BLOB))
  WHERE (scope='global' AND subject='all')
     OR (scope='account' AND subject=NEW.submitted_by)
     OR (scope='developer' AND subject=NEW.developer_id);
  SELECT CASE WHEN length(CAST(NEW.content AS BLOB)) > length(CAST(OLD.content AS BLOB)) AND EXISTS (
    SELECT 1 FROM extension_resource_usage
    WHERE ((scope='account' AND subject=NEW.submitted_by)
        OR (scope='developer' AND subject=NEW.developer_id))
      AND (bytes>26214400 OR extensions>100 OR revisions>1000)
  )
  THEN RAISE(ABORT,'extension_resource_quota') END;
END;
--> statement-breakpoint
CREATE TRIGGER resource_extension_revisions_identity_update AFTER UPDATE OF submitted_by,developer_id ON extension_revisions
WHEN NEW.submitted_by IS NOT OLD.submitted_by OR NEW.developer_id IS NOT OLD.developer_id BEGIN
UPDATE extension_resource_usage SET bytes=bytes+((length(CAST(OLD.content AS BLOB))) * -1), revisions=revisions+(-1)
  WHERE scope='global' AND subject='all';
UPDATE extension_resource_usage SET bytes=bytes+((length(CAST(OLD.content AS BLOB))) * -1), revisions=revisions+(-1)
  WHERE scope='account' AND subject=OLD.submitted_by;
UPDATE extension_resource_usage SET bytes=bytes+((length(CAST(OLD.content AS BLOB))) * -1), revisions=revisions+(-1)
  WHERE scope='developer' AND subject=OLD.developer_id;
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions) VALUES ('global','all',(length(CAST(NEW.content AS BLOB))),0,1)
  ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes,extensions=extensions+excluded.extensions,revisions=revisions+excluded.revisions;
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions) VALUES ('account',NEW.submitted_by,(length(CAST(NEW.content AS BLOB))),0,1)
  ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes,extensions=extensions+excluded.extensions,revisions=revisions+excluded.revisions;
SELECT CASE WHEN ((length(CAST(NEW.content AS BLOB))) > (length(CAST(OLD.content AS BLOB)))) AND EXISTS (SELECT 1 FROM extension_resource_usage
  WHERE scope='account' AND subject=NEW.submitted_by AND (bytes>26214400 OR extensions>100 OR revisions>1000))
  THEN RAISE(ABORT,'extension_resource_quota') END;
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions) VALUES ('developer',NEW.developer_id,(length(CAST(NEW.content AS BLOB))),0,1)
  ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes,extensions=extensions+excluded.extensions,revisions=revisions+excluded.revisions;
SELECT CASE WHEN ((length(CAST(NEW.content AS BLOB))) > (length(CAST(OLD.content AS BLOB)))) AND EXISTS (SELECT 1 FROM extension_resource_usage
  WHERE scope='developer' AND subject=NEW.developer_id AND (bytes>26214400 OR extensions>100 OR revisions>1000))
  THEN RAISE(ABORT,'extension_resource_quota') END;
END;
--> statement-breakpoint
CREATE TRIGGER extension_revision_admission BEFORE INSERT ON extension_revisions BEGIN
  -- Cleanup scales with accepted writes; idle cleanup still runs hourly.
  DELETE FROM extension_write_events WHERE id IN (
    SELECT id FROM extension_write_events WHERE occurred_at <= unixepoch()-86400
    ORDER BY occurred_at LIMIT 50
  );
  SELECT CASE WHEN length(CAST(NEW.content AS BLOB)) > 262144

  THEN RAISE(ABORT,'extension_content_size') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM extension_write_events WHERE account_id=NEW.submitted_by AND occurred_at>unixepoch()-60)>=5
    OR (SELECT COUNT(*) FROM extension_write_events WHERE developer_id=NEW.developer_id AND occurred_at>unixepoch()-60)>=5

  THEN RAISE(ABORT,'extension_write_rate_minute') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM extension_write_events WHERE account_id=NEW.submitted_by AND occurred_at>unixepoch()-86400)>=50
    OR (SELECT COUNT(*) FROM extension_write_events WHERE developer_id=NEW.developer_id AND occurred_at>unixepoch()-86400)>=50

  THEN RAISE(ABORT,'extension_write_rate_day') END;
END;
--> statement-breakpoint
CREATE TRIGGER extension_revision_write_event AFTER INSERT ON extension_revisions BEGIN
  INSERT INTO extension_write_events(id,account_id,developer_id,occurred_at)
  VALUES (NEW.id,NEW.submitted_by,NEW.developer_id,unixepoch(NEW.created_at));
END;
--> statement-breakpoint
CREATE TRIGGER extension_revision_content_bound BEFORE UPDATE OF content ON extension_revisions
WHEN length(CAST(NEW.content AS BLOB)) > 262144 AND length(CAST(NEW.content AS BLOB)) > length(CAST(OLD.content AS BLOB))
BEGIN SELECT RAISE(ABORT,'extension_content_size'); END;
--> statement-breakpoint
CREATE TRIGGER extension_revision_identity BEFORE UPDATE OF id,extension_id,developer_id,submitted_by ON extension_revisions
WHEN NEW.id IS NOT OLD.id OR NEW.extension_id IS NOT OLD.extension_id
  OR NEW.developer_id IS NOT OLD.developer_id OR NEW.submitted_by IS NOT OLD.submitted_by
BEGIN SELECT RAISE(ABORT,'extension_resource_identity'); END;
--> statement-breakpoint
CREATE TRIGGER extension_resource_identity BEFORE UPDATE OF created_by,developer_id ON extensions
WHEN NEW.created_by IS NOT OLD.created_by OR NEW.developer_id IS NOT OLD.developer_id
BEGIN SELECT RAISE(ABORT,'extension_resource_identity'); END;
--> statement-breakpoint
CREATE TRIGGER sync_extension_revisions_bytes_insert AFTER INSERT ON extension_revisions
WHEN NEW.content_bytes != (length(CAST(NEW.content AS BLOB))) BEGIN
  UPDATE extension_revisions SET content_bytes=(length(CAST(NEW.content AS BLOB)))
  WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER sync_extension_revisions_bytes_update AFTER UPDATE OF content,content_bytes ON extension_revisions
WHEN NEW.content_bytes != (length(CAST(NEW.content AS BLOB))) BEGIN
  UPDATE extension_revisions SET content_bytes=(length(CAST(NEW.content AS BLOB)))
  WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER sync_revision_summary_insert AFTER INSERT ON extension_revisions
WHEN NEW.compacted_at IS NULL BEGIN
  UPDATE extension_revisions SET content_readable = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content) THEN
      CASE WHEN json_type(NEW.content) != 'object' THEN 0
        WHEN json_type(NEW.content, '$.releases') IS NULL OR json_type(NEW.content, '$.releases') = 'null' THEN 1
        WHEN json_type(NEW.content, '$.releases') != 'array' THEN 0
        WHEN json_array_length(NEW.content, '$.releases') > 100 THEN 0
        ELSE NOT EXISTS (SELECT 1 FROM json_each(NEW.content, '$.releases') r
          WHERE CASE WHEN r.type = 'object' THEN
            json_type(r.value, '$.tag') IS NOT 'text' OR length(json_extract(r.value, '$.tag')) > 100
            ELSE 1 END)
      END ELSE 0 END,
    summary_name = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.name')='text' THEN substr(json_extract(NEW.content,'$.name'),1,120) ELSE NULL END
      ELSE NULL END,
    summary_version = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.version')='text' THEN substr(json_extract(NEW.content,'$.version'),1,100) ELSE NULL END
      ELSE NULL END,
    summary_description = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.description')='text' THEN substr(json_extract(NEW.content,'$.description'),1,4000) ELSE NULL END
      ELSE NULL END
  WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER sync_revision_summary_update AFTER UPDATE OF content ON extension_revisions
WHEN NEW.compacted_at IS NULL BEGIN
  UPDATE extension_revisions SET content_readable = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content) THEN
      CASE WHEN json_type(NEW.content) != 'object' THEN 0
        WHEN json_type(NEW.content, '$.releases') IS NULL OR json_type(NEW.content, '$.releases') = 'null' THEN 1
        WHEN json_type(NEW.content, '$.releases') != 'array' THEN 0
        WHEN json_array_length(NEW.content, '$.releases') > 100 THEN 0
        ELSE NOT EXISTS (SELECT 1 FROM json_each(NEW.content, '$.releases') r
          WHERE CASE WHEN r.type = 'object' THEN
            json_type(r.value, '$.tag') IS NOT 'text' OR length(json_extract(r.value, '$.tag')) > 100
            ELSE 1 END)
      END ELSE 0 END,
    summary_name = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.name')='text' THEN substr(json_extract(NEW.content,'$.name'),1,120) ELSE NULL END
      ELSE NULL END,
    summary_version = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.version')='text' THEN substr(json_extract(NEW.content,'$.version'),1,100) ELSE NULL END
      ELSE NULL END,
    summary_description = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.description')='text' THEN substr(json_extract(NEW.content,'$.description'),1,4000) ELSE NULL END
      ELSE NULL END
  WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER developers_generate_profile_instance
AFTER INSERT ON developers
BEGIN
  UPDATE developers SET profile_generation = lower(hex(randomblob(16)))
  WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER resource_extensions_insert AFTER INSERT ON extensions BEGIN
  INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions)
  SELECT scope, subject, COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0), 1, 0
  FROM (
    SELECT 'global' AS scope, 'all' AS subject
    UNION ALL SELECT 'account', COALESCE(NEW.created_by,'legacy')
    UNION ALL SELECT 'developer', NEW.developer_id
  ) WHERE true
  ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes,
    extensions=extensions+excluded.extensions,
    revisions=revisions+excluded.revisions;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM extension_resource_usage
    WHERE ((scope='account' AND subject=COALESCE(NEW.created_by,'legacy'))
        OR (scope='developer' AND subject=NEW.developer_id))
      AND (bytes>26214400 OR extensions>100 OR revisions>1000)
  ) THEN RAISE(ABORT,'extension_resource_quota') END;
END;
--> statement-breakpoint
CREATE TRIGGER sync_extensions_bytes_insert AFTER INSERT ON extensions
WHEN NEW.published_bytes != (COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0)) BEGIN
  UPDATE extensions SET published_bytes=(COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0))
  WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER sync_extensions_bytes_update AFTER UPDATE OF type,name,description,releases,website,license,icon_url,readme,source,version,download_url,manifest,published_bytes ON extensions
WHEN NEW.published_bytes != (COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0)) BEGIN
  UPDATE extensions SET published_bytes=(COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0))
  WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER resource_extensions_delete AFTER DELETE ON extensions BEGIN
  UPDATE extension_resource_usage
  SET bytes=bytes-(COALESCE(length(CAST(OLD.manifest AS BLOB)),0) + COALESCE(length(CAST(OLD.type AS BLOB)),0)
    + COALESCE(length(CAST(OLD.name AS BLOB)),0)
    + COALESCE(length(CAST(OLD.description AS BLOB)),0)
    + COALESCE(length(CAST(OLD.releases AS BLOB)),0)
    + COALESCE(length(CAST(OLD.website AS BLOB)),0)
    + COALESCE(length(CAST(OLD.license AS BLOB)),0)
    + COALESCE(length(CAST(OLD.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(OLD.readme AS BLOB)),0)
    + COALESCE(length(CAST(OLD.source AS BLOB)),0)
    + COALESCE(length(CAST(OLD.version AS BLOB)),0)
    + COALESCE(length(CAST(OLD.download_url AS BLOB)),0)), extensions=extensions-1
  WHERE (scope='global' AND subject='all')
     OR (scope='account' AND subject=COALESCE(OLD.created_by,'legacy'))
     OR (scope='developer' AND subject=OLD.developer_id);
END;
--> statement-breakpoint
CREATE TRIGGER resource_extensions_update AFTER UPDATE OF type,name,description,releases,website,license,icon_url,readme,source,version,download_url,manifest ON extensions BEGIN
  UPDATE extension_resource_usage
  SET bytes = bytes + (COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0)) - (COALESCE(length(CAST(OLD.manifest AS BLOB)),0)
    + COALESCE(length(CAST(OLD.type AS BLOB)),0)
    + COALESCE(length(CAST(OLD.name AS BLOB)),0)
    + COALESCE(length(CAST(OLD.description AS BLOB)),0)
    + COALESCE(length(CAST(OLD.releases AS BLOB)),0)
    + COALESCE(length(CAST(OLD.website AS BLOB)),0)
    + COALESCE(length(CAST(OLD.license AS BLOB)),0)
    + COALESCE(length(CAST(OLD.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(OLD.readme AS BLOB)),0)
    + COALESCE(length(CAST(OLD.source AS BLOB)),0)
    + COALESCE(length(CAST(OLD.version AS BLOB)),0)
    + COALESCE(length(CAST(OLD.download_url AS BLOB)),0))
  WHERE (scope='global' AND subject='all')
     OR (scope='account' AND subject=COALESCE(NEW.created_by,'legacy'))
     OR (scope='developer' AND subject=NEW.developer_id);
  SELECT CASE WHEN (COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0)) > (COALESCE(length(CAST(OLD.manifest AS BLOB)),0)
    + COALESCE(length(CAST(OLD.type AS BLOB)),0)
    + COALESCE(length(CAST(OLD.name AS BLOB)),0)
    + COALESCE(length(CAST(OLD.description AS BLOB)),0)
    + COALESCE(length(CAST(OLD.releases AS BLOB)),0)
    + COALESCE(length(CAST(OLD.website AS BLOB)),0)
    + COALESCE(length(CAST(OLD.license AS BLOB)),0)
    + COALESCE(length(CAST(OLD.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(OLD.readme AS BLOB)),0)
    + COALESCE(length(CAST(OLD.source AS BLOB)),0)
    + COALESCE(length(CAST(OLD.version AS BLOB)),0)
    + COALESCE(length(CAST(OLD.download_url AS BLOB)),0)) AND EXISTS (
    SELECT 1 FROM extension_resource_usage
    WHERE ((scope='account' AND subject=COALESCE(NEW.created_by,'legacy'))
        OR (scope='developer' AND subject=NEW.developer_id))
      AND (bytes>26214400 OR extensions>100 OR revisions>1000)
  )
  THEN RAISE(ABORT,'extension_resource_quota') END;
END;
--> statement-breakpoint
CREATE TRIGGER extensions_published_manifest_insert BEFORE INSERT ON extensions
WHEN NEW.published_at IS NOT NULL AND NEW.manifest IS NULL
BEGIN SELECT RAISE(ABORT,'extensions_published_manifest_required'); END;
--> statement-breakpoint
CREATE TRIGGER extensions_published_manifest_update BEFORE UPDATE OF published_at,manifest ON extensions
WHEN NEW.published_at IS NOT NULL AND NEW.manifest IS NULL
BEGIN SELECT RAISE(ABORT,'extensions_published_manifest_required'); END;
--> statement-breakpoint
UPDATE extension_resource_usage SET subject=(SELECT id FROM _developers_ids WHERE identifier=subject) WHERE scope='developer' AND subject IN (SELECT identifier FROM _developers_ids);
--> statement-breakpoint
DROP TABLE _developers_backup;
--> statement-breakpoint
DROP TABLE _extensions_backup;
--> statement-breakpoint
DROP TABLE _developer_transfers_backup;
--> statement-breakpoint
DROP TABLE _developer_claims_backup;
--> statement-breakpoint
DROP TABLE _developer_history_backup;
--> statement-breakpoint
DROP TABLE _extension_write_events_backup;
--> statement-breakpoint
DROP TABLE _m2m_publisher_clients_backup;
--> statement-breakpoint
DROP TABLE _extension_revisions_backup;
--> statement-breakpoint
DROP TABLE _developers_ids;
--> statement-breakpoint
DROP TABLE _extensions_ids;
