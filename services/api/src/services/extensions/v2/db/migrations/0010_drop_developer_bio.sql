-- v2: drop developers.bio — this profile field turned out not to be useful
-- and is being removed from the API surface entirely.

ALTER TABLE developers DROP COLUMN bio;
