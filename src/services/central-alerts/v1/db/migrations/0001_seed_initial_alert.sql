-- Data seed, split out from the schema migration (0000) so future schema
-- diffs never touch it. Ported verbatim from the old db/init.sql bootstrap.
INSERT OR IGNORE INTO central_alerts (id, title, message, type, dismissible, min_fossbilling_version, max_fossbilling_version, include_preview_branch, datetime, buttons) VALUES
('1', 'This version of FOSSBilling is insecure', 'FOSSBilling versions older than 0.5.3 are vulnerable to SQL injection with a critical (9.8) severity. Please update now to protect you and your customers.', 'danger', false, '0.0.0', '0.5.2', false, '2023-06-30T21:43:03+00:00',
'[{"text": "CVE Details", "link": "https://nvd.nist.gov/vuln/detail/CVE-2023-3490", "type": "info"}, {"text": "Original vulnerability report", "link": "https://huntr.dev/bounties/4e60ebc1-e00f-48cb-b011-3cefce688ecd/", "type": "info"}]');
