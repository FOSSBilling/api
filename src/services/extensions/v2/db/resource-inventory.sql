-- Read-only reconciliation; scalar stored sizes avoid transferring bodies.
WITH component_usage AS (
SELECT 'global' scope, 'all' subject, SUM(published_bytes) bytes, COUNT(*) extensions, 0 revisions FROM extensions GROUP BY 'all'
UNION ALL
SELECT 'account' scope, COALESCE(created_by,'legacy') subject, SUM(published_bytes) bytes, COUNT(*) extensions, 0 revisions FROM extensions GROUP BY COALESCE(created_by,'legacy')
UNION ALL
SELECT 'developer' scope, developer_id subject, SUM(published_bytes) bytes, COUNT(*) extensions, 0 revisions FROM extensions GROUP BY developer_id
UNION ALL
SELECT 'global' scope, 'all' subject, SUM(content_bytes) bytes, 0 extensions, COUNT(*) revisions FROM extension_revisions GROUP BY 'all'
UNION ALL
SELECT 'account' scope, submitted_by subject, SUM(content_bytes) bytes, 0 extensions, COUNT(*) revisions FROM extension_revisions GROUP BY submitted_by
UNION ALL
SELECT 'developer' scope, developer_id subject, SUM(content_bytes) bytes, 0 extensions, COUNT(*) revisions FROM extension_revisions GROUP BY developer_id
), expected AS (
 SELECT scope,subject,SUM(bytes) bytes,SUM(extensions) extensions,SUM(revisions) revisions
 FROM component_usage GROUP BY scope,subject
), subjects AS (
 SELECT scope,subject FROM expected UNION SELECT scope,subject FROM extension_resource_usage
)
SELECT s.scope,s.subject,COALESCE(e.bytes,0) expected_bytes,COALESCE(u.bytes,0) stored_bytes,
 COALESCE(e.extensions,0) expected_extensions,COALESCE(u.extensions,0) stored_extensions,
 COALESCE(e.revisions,0) expected_revisions,COALESCE(u.revisions,0) stored_revisions
FROM subjects s LEFT JOIN expected e USING(scope,subject)
LEFT JOIN extension_resource_usage u USING(scope,subject)
WHERE COALESCE(e.bytes,0)!=COALESCE(u.bytes,0) OR COALESCE(e.extensions,0)!=COALESCE(u.extensions,0)
 OR COALESCE(e.revisions,0)!=COALESCE(u.revisions,0)
LIMIT 100;
