import { DurableObject } from "cloudflare:workers";

// One singleton for all preview traffic, independent of URL, client and colo.
// Token buckets permit 60 calls in a burst, then 1000/hour globally and
// 120/hour per client. Every upstream call (not just each lookup) costs one.
export class PreviewGitHubBudget extends DurableObject<CloudflareBindings> {
  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS buckets (
      key TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL
    )`);
  }

  reserve(client: string): boolean {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      // A client bucket is full after 30 minutes; discard only older state.
      this.ctx.storage.sql.exec(
        "DELETE FROM buckets WHERE key != 'global' AND updated_at < ?",
        now - 1800000
      );
      const buckets = [
        { key: "global", rate: 1000 / 3600000 },
        { key: `client:${client}`, rate: 120 / 3600000 }
      ].map(({ key, rate }) => {
        const row = this.ctx.storage.sql
          .exec<{ tokens: number; updated_at: number }>(
            "SELECT tokens, updated_at FROM buckets WHERE key = ?",
            key
          )
          .toArray()[0];
        const tokens = row
          ? Math.min(60, row.tokens + Math.max(0, now - row.updated_at) * rate)
          : 60;
        return { key, tokens };
      });
      if (buckets.some(({ tokens }) => tokens < 1)) return false;
      for (const { key, tokens } of buckets) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO buckets (key, tokens, updated_at) VALUES (?, ?, ?)",
          key,
          tokens - 1,
          now
        );
      }
      return true;
    });
  }
}
