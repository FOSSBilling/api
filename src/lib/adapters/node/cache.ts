import { DatabaseSync } from "node:sqlite";
import { ICache, CacheOptions } from "../../interfaces";

export class SQLiteCacheAdapter implements ICache {
  private db: DatabaseSync;
  private stmtGet: ReturnType<DatabaseSync["prepare"]>;
  private stmtPut: ReturnType<DatabaseSync["prepare"]>;
  private stmtDelete: ReturnType<DatabaseSync["prepare"]>;
  private stmtClearExpired: ReturnType<DatabaseSync["prepare"]>;

  constructor(database: DatabaseSync) {
    this.db = database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expire_at INTEGER
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cache_expire_at ON cache(expire_at)
    `);

    this.stmtGet = this.db.prepare(
      `SELECT value FROM cache 
       WHERE key = ? AND (expire_at IS NULL OR expire_at > ?)
       LIMIT 1`
    );
    this.stmtPut = this.db.prepare(`
      INSERT OR REPLACE INTO cache (key, value, expire_at) 
      VALUES (?, ?, ?)
    `);
    this.stmtDelete = this.db.prepare(`DELETE FROM cache WHERE key = ?`);
    this.stmtClearExpired = this.db.prepare(
      `DELETE FROM cache WHERE expire_at IS NOT NULL AND expire_at <= ?`
    );
  }

  async get(key: string): Promise<string | null> {
    const result = this.stmtGet.get(key, Date.now()) as
      { value: string } | undefined;
    return result?.value ?? null;
  }

  async put(key: string, value: string, options?: CacheOptions): Promise<void> {
    let expireAt: number | null = null;
    const now = Date.now();

    if (options?.expirationTtl) {
      expireAt = now + options.expirationTtl * 1000;
    } else if (options?.expiration) {
      expireAt = options.expiration * 1000;
    }

    this.stmtPut.run(key, value, expireAt);
  }

  async delete(key: string): Promise<void> {
    this.stmtDelete.run(key);
  }

  clearExpired(): void {
    this.stmtClearExpired.run(Date.now());
  }

  clearAll(): void {
    this.db.exec(`DELETE FROM cache`);
  }

  close(): void {
    this.db.close();
  }
}

export function createMemoryCache(): SQLiteCacheAdapter {
  const db = new DatabaseSync(":memory:");
  return new SQLiteCacheAdapter(db);
}

export function createFileCache(dbPath: string): SQLiteCacheAdapter {
  const db = new DatabaseSync(dbPath);
  return new SQLiteCacheAdapter(db);
}
