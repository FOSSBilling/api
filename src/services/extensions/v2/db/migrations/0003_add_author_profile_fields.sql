-- v2: additional developer-profile fields for the public /developer/{id}
-- page (bio, avatar_url) and moderator/maintainer contact (contact_email,
-- never exposed on public reads). Extends the legacy authors table now owned by
-- the API.

ALTER TABLE authors ADD COLUMN bio           TEXT;
ALTER TABLE authors ADD COLUMN avatar_url    TEXT;
ALTER TABLE authors ADD COLUMN contact_email TEXT;
