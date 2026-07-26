-- Bind moderation decisions to the ownership/content state that was reviewed.
ALTER TABLE developers
  ADD COLUMN ownership_epoch INTEGER NOT NULL DEFAULT 1 CHECK (ownership_epoch >= 1);
ALTER TABLE developers
  ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1 CHECK (content_revision >= 1);
ALTER TABLE developers
  ADD COLUMN approved_revision INTEGER;
ALTER TABLE developers
  ADD COLUMN approved_by TEXT;

-- Preserve approvals that predate revision tracking.
UPDATE developers
SET approved_revision = content_revision
WHERE approved_at IS NOT NULL;

ALTER TABLE extension_submissions
  ADD COLUMN ownership_epoch INTEGER NOT NULL DEFAULT 1 CHECK (ownership_epoch >= 1);
ALTER TABLE extension_submissions
  ADD COLUMN target_key TEXT;

UPDATE extension_submissions
SET target_key = LOWER(COALESCE(extension_id, json_extract(payload, '$.extension.id')));

-- Deployments with duplicate pending rows must reconcile them before applying
-- this migration; silently choosing one would mutate moderation state.
CREATE UNIQUE INDEX idx_extension_submissions_pending_target
  ON extension_submissions(submitted_by, target_key)
  WHERE status = 'pending';

CREATE INDEX idx_extension_submissions_submitter_page
  ON extension_submissions(submitted_by, created_at DESC, id DESC);
CREATE INDEX idx_extension_submissions_queue_page
  ON extension_submissions(status, created_at ASC, id ASC);
