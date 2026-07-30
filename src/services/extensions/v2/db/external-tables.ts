import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Owned by the sibling FOSSBilling/extensions repo (src/lib/db/users.sql
// there), NOT this repo, but lives in the same DB_EXTENSIONS database.
// Deliberately kept out of schema.ts (drizzle-kit's scan target - see
// drizzle.extensions.config.ts) so drizzle-kit never thinks it owns and
// should generate migrations for a table this repo doesn't manage. This is
// a second, purely-for-reading definition of the same physical table
// schema.ts's `users` (id only) already declares for FK-reference purposes
// - if the sibling repo's columns change, update both.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  isModerator: integer("is_moderator"),
  githubLogin: text("github_login"),
  githubOrgs: text("github_orgs")
});
