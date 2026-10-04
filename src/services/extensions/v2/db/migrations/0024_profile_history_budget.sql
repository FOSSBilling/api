CREATE INDEX IF NOT EXISTS idx_developer_history_account_changed_at
ON developer_history (changed_by, changed_at);
