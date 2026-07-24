import { DatabaseResult, IDatabase } from "../../../lib/interfaces";
import { databaseError } from "./errors";

// `users` is owned by the FOSSBilling/extensions repo (src/lib/db/users.sql there),
// NOT this repo, but lives in the same DB_EXTENSIONS database. If that schema
// changes (columns renamed/dropped), update fossbilling/api AND that file. Assumed
// columns used here: users.id (TEXT, = auth `sub` claim), users.is_moderator
// (INTEGER 0/1).
export class UsersDatabase {
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  async isModerator(userId: string): Promise<DatabaseResult<boolean>> {
    try {
      const row = await this.db
        .prepare("SELECT is_moderator FROM users WHERE id = ?")
        .bind(userId)
        .first<{ is_moderator: number }>();
      return { data: row?.is_moderator === 1, error: null };
    } catch (error) {
      return databaseError("isModerator", error);
    }
  }
}
