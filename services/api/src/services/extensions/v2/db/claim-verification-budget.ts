import { sql } from "drizzle-orm";
import { ExtensionsDb } from "../../../../lib/db";

// Claim attempts retain their budget regardless of verification outcome or
// claim cancellation. D1 serializes this single conditional write across
// isolates: either all three budgets are charged or none are.
export async function reserveClaimVerification(
  db: ExtensionsDb,
  claimantId: string,
  developerId: string
): Promise<boolean> {
  await db.run(sql`DELETE FROM claim_verification_budgets
    WHERE expires_at <= unixepoch()`);
  const rows = await db.all<{ key: string }>(sql`
    WITH requested(key, allowance, period) AS (
      VALUES (${`account:${claimantId}`}, 3, 60),
             (${`developer:${developerId.toLowerCase()}`}, 3, 60),
             ('global', 300, 3600)
    )
    INSERT INTO claim_verification_budgets (key, attempts, expires_at)
      SELECT key, 1, unixepoch() + period FROM requested
      WHERE NOT EXISTS (
        SELECT 1 FROM requested r
        JOIN claim_verification_budgets b ON b.key = r.key
        WHERE b.expires_at > unixepoch() AND b.attempts >= r.allowance
      )
    ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN expires_at <= unixepoch() THEN 1 ELSE attempts + 1 END,
      expires_at = CASE WHEN expires_at <= unixepoch()
        THEN excluded.expires_at ELSE expires_at END
    RETURNING key
  `);
  return rows.length === 3;
}
