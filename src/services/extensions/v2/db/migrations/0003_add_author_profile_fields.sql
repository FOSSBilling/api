-- v2: additional developer-profile fields for the public /developer/{id}
-- page (bio, avatar_url) and moderator/maintainer contact (contact_email,
-- never exposed on public reads). Adds to the v1-owned `authors` table.

ALTER TABLE authors ADD COLUMN bio           TEXT;
ALTER TABLE authors ADD COLUMN avatar_url    TEXT;
ALTER TABLE authors ADD COLUMN contact_email TEXT;
