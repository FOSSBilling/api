-- Read-only pre-deployment report. Correct every returned row before 0029.
-- Revision audit bodies are excluded.
WITH published AS (
  SELECT e.*, d.name AS author_name, d.url AS author_url,
    CASE WHEN json_valid(e.license) THEN CASE json_type(e.license)
      WHEN 'text' THEN json_extract(e.license,'$')
      WHEN 'object' THEN CASE
        WHEN json_type(e.license,'$.spdx_id') = 'text' THEN json_extract(e.license,'$.spdx_id')
        WHEN json_type(e.license,'$.spdx_id') IS NULL OR json_type(e.license,'$.spdx_id') = 'null'
          THEN CASE WHEN json_type(e.license,'$.name') = 'text' THEN json_extract(e.license,'$.name') END
      END END END AS manifest_license
  FROM extensions e JOIN developers d ON d.id = e.developer_id
  WHERE e.published_at IS NOT NULL
), release_rows AS (
  SELECT p.id, r.key AS release_index, r.type AS release_type,
    CASE WHEN r.type = 'object' THEN CASE
      WHEN json_type(r.value,'$.requires') IS NULL
        AND json_type(r.value,'$.min_fossbilling_version') = 'text'
        AND length(trim(json_extract(r.value,'$.min_fossbilling_version'))) BETWEEN 1 AND 100
      THEN json_set(r.value,'$.requires',json_object('fossbilling','>=' || trim(json_extract(r.value,'$.min_fossbilling_version'))))
      ELSE r.value END ELSE '{}' END AS release
  FROM published p, json_each(CASE WHEN json_valid(p.releases) THEN p.releases ELSE '[]' END) r
)
SELECT p.id, NULL AS release_index, problem.value AS issue
FROM published p, json_each(json_array(
  CASE WHEN p.type NOT IN ('mod','module','theme','payment-gateway','server-manager','domain-registrar','translation')
    THEN 'type: choose a supported manifest type (mod will become module)' END,
  CASE WHEN p.manifest_license IS NULL OR length(trim(p.manifest_license)) NOT BETWEEN 1 AND 1000 OR p.manifest_license GLOB '*[^A-Za-z0-9.()+_: |-]*'
    THEN 'license: supply a valid manifest license string or legacy spdx_id/name' END,
  CASE WHEN length(trim(p.author_name)) = 0 OR length(p.author_name) > 200
    OR (p.author_url IS NOT NULL AND p.author_url != '' AND (length(p.author_url) > 2048
      OR (p.author_url NOT LIKE 'https://%' AND p.author_url NOT LIKE 'http://%')
      OR substr(p.author_url,instr(p.author_url,'://')+3,1) IN ('','/','?','#')
      OR p.author_url GLOB ('*[' || char(9) || char(10) || char(13) || ' ]*')))
    THEN 'author: correct the developer name/URL before copying package attribution' END,
  CASE WHEN CASE WHEN NOT json_valid(p.releases) THEN 1 WHEN json_type(p.releases) != 'array' THEN 1 ELSE json_array_length(p.releases) NOT BETWEEN 1 AND 100 END
    THEN 'releases: supply a non-empty JSON array with at most 100 releases' END,
  CASE WHEN (SELECT COUNT(*) FROM release_rows r WHERE r.id=p.id AND json_extract(r.release,'$.tag') IN (p.version,'v'||p.version)) != 1
    THEN 'version: identify exactly one current release matching version or v+version' END
)) problem WHERE problem.value IS NOT NULL
UNION ALL
SELECT id, release_index, 'requires: supply a FOSSBilling constraint or legacy minimum and a valid optional PHP constraint'
FROM release_rows WHERE release_type != 'object'
  OR COALESCE(json_type(release,'$.requires'),'') != 'object'
  OR COALESCE(json_type(release,'$.requires.fossbilling'),'') != 'text'
  OR COALESCE(length(trim(json_extract(release,'$.requires.fossbilling'))),0) NOT BETWEEN 1 AND 1000
  OR (json_type(release,'$.requires.php') IS NOT NULL AND (json_type(release,'$.requires.php') != 'text'
    OR length(trim(json_extract(release,'$.requires.php'))) NOT BETWEEN 1 AND 1000))
  OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(release,'$.requires') = 'object' THEN json_extract(release,'$.requires') ELSE '{}' END)
    WHERE key NOT IN ('fossbilling','php','modules'))
  OR (json_type(release,'$.requires.modules') IS NOT NULL AND json_type(release,'$.requires.modules') != 'object')
  OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(release,'$.requires.modules') = 'object' THEN json_extract(release,'$.requires.modules') ELSE '{}' END)
    WHERE key = '' OR key GLOB '*[^a-z0-9_-]*' OR type != 'text' OR length(trim(value)) NOT BETWEEN 1 AND 1000)
ORDER BY id, release_index, issue;
