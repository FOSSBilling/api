-- Fails the migration if an adopted developer row holds an id that a static
-- route shadows, so the collision surfaces before a deploy rather than as a
-- permanently unreachable detail page.
--
-- GET /developers/{me,claims,unapproved} is registered before
-- GET /developers/{id} (see index.ts). A row carrying one of those ids is
-- still listed by the collection endpoints but its own detail page resolves
-- to the static route instead. New writes are rejected by schema validation;
-- rows adopted from the pre-v2 catalogue predate it, which is what this
-- checks.
--
-- (The former extensions.id = 'mine' branch was removed when the static
-- GET /extensions/mine route merged into GET /extensions?scope=mine: no
-- static segment shadows it anymore, so 'mine' is a usable extension id.)
--
-- Exact match, not lower(id): route matching is case-sensitive, so only an
-- exact-lowercase id collides. A row id'd "Me" resolves normally and must
-- not fail a deploy.
--
-- There is no RAISE() outside a trigger in SQLite, so the abort is a CHECK
-- violation on a scratch table. If this migration fails, do not rename the
-- row here - the id is public and consumers pin it. Decide deliberately.
CREATE TABLE _reserved_route_id_check (ok INTEGER NOT NULL CHECK (ok = 1));

INSERT INTO _reserved_route_id_check (ok)
SELECT
  CASE
    WHEN EXISTS (
      SELECT 1 FROM developers WHERE id IN ('me', 'claims', 'unapproved')
    ) THEN 0
    ELSE 1
  END;

DROP TABLE _reserved_route_id_check;
