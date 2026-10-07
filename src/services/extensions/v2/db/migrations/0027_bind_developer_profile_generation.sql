-- SQLite requires a constant ADD COLUMN default on this populated parent.
-- Backfill a distinct opaque instance token without rebuilding its children.
ALTER TABLE `developers` ADD `profile_generation` text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- Previous rules could preserve approval across unreviewed edits. Require a
-- fresh review of existing profiles, retaining their GitHub verification.
UPDATE developers
SET profile_generation = lower(hex(randomblob(16))),
    approved_at = NULL, approved_revision = NULL, approved_by = NULL;
--> statement-breakpoint
-- Generate tokens here so API creation and raw imports use the same path.
CREATE TRIGGER developers_generate_profile_instance
AFTER INSERT ON developers
WHEN NEW.profile_generation = ''
BEGIN
  UPDATE developers SET profile_generation = lower(hex(randomblob(16)))
  WHERE id = NEW.id;
END;
