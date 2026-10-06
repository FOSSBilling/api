import { sql } from "drizzle-orm";
import { ExtensionsDb } from "../../../../lib/db";
import { logInfo, logWarn } from "../../../../lib/logger";
import {
  MAX_CONTENT_BYTES,
  RETENTION_DAYS,
  MAINTENANCE_BATCH_SIZE
} from "../resource-limits";

// Pending, published and oversized legacy bodies are never compacted.
export async function maintainExtensionResources(
  db: ExtensionsDb,
  options: { mode?: string } = {}
): Promise<void> {
  const mode = options.mode === "compact" ? "compact" : "dry-run";
  const candidates =
    mode === "compact"
      ? await db.all<{ id: string }>(sql`
    SELECT r.id FROM extension_revisions r
    WHERE r.status IN ('approved','rejected') AND r.compacted_at IS NULL
      AND r.reviewed_at < datetime('now', ${`-${RETENTION_DAYS} days`})
      AND r.content_bytes <= ${MAX_CONTENT_BYTES}
      AND NOT EXISTS (SELECT 1 FROM extensions e WHERE e.published_revision_id=r.id)
    ORDER BY r.reviewed_at, r.id LIMIT ${MAINTENANCE_BATCH_SIZE}
  `)
      : [];
  let compacted = 0;
  for (const { id } of candidates) {
    const [row] = await db.all<{ content: string }>(sql`
      SELECT content FROM extension_revisions WHERE id=${id}
        AND content_bytes <= ${MAX_CONTENT_BYTES} AND compacted_at IS NULL
    `);
    if (!row) continue;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(row.content)
    );
    const hash = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
    const result = await db.run(sql`
      UPDATE extension_revisions SET content='{}', content_hash=${hash}, compacted_at=CURRENT_TIMESTAMP
      WHERE id=${id} AND content=${row.content} AND compacted_at IS NULL
        AND status IN ('approved','rejected')
        AND reviewed_at < datetime('now', ${`-${RETENTION_DAYS} days`})
        AND NOT EXISTS (SELECT 1 FROM extensions e WHERE e.published_revision_id=extension_revisions.id)
    `);
    compacted += result.meta?.changes ?? 0;
  }
  const expired = await db.run(sql`
    DELETE FROM extension_write_events WHERE id IN (
      SELECT id FROM extension_write_events WHERE occurred_at <= unixepoch()-86400
      ORDER BY occurred_at LIMIT 500
    )
  `);
  await db.run(sql`
    DELETE FROM extension_resource_usage WHERE rowid IN (
      SELECT rowid FROM extension_resource_usage WHERE scope!='global'
        AND bytes=0 AND extensions=0 AND revisions=0 LIMIT 500
    )
  `);
  logInfo("extensions-v2", "Resource maintenance", {
    retention_mode: mode,
    compacted,
    expired_events: expired.meta?.changes ?? 0
  });
}

// Read-only inventory, reported after hourly cleanup.
export async function reportExtensionResources(
  db: ExtensionsDb,
  retentionMode?: string
): Promise<void> {
  const mode = retentionMode === "compact" ? "compact" : "dry-run";
  const retention = await inventoryExtensionRetention(db);
  const [usage] = await db.all<{
    bytes: number;
    extensions: number;
    revisions: number;
  }>(sql`
    SELECT bytes, extensions, revisions FROM extension_resource_usage WHERE scope='global' AND subject='all'
  `);
  const [backlog] = await db.all<{
    oversized: number;
    pending: number;
  }>(sql`
    SELECT SUM(content_bytes > ${MAX_CONTENT_BYTES}) AS oversized,
      SUM(status='pending') AS pending
    FROM extension_revisions
  `);
  logInfo("extensions-v2", "Resource inventory", {
    retention_mode: mode,
    eligible_bodies: retention.eligible_bodies,
    reclaimable_bytes: retention.reclaimable_bytes,
    retained_bytes: usage?.bytes ?? 0,
    extensions: usage?.extensions ?? 0,
    revisions: usage?.revisions ?? 0,
    pending: backlog?.pending ?? 0,
    oversized_legacy_revisions: backlog?.oversized ?? 0,
    cleanup_backlog: retention.eligible_bodies
  });
  const thresholds = [
    ["legacy_content_present", backlog?.oversized ?? 0, 1],
    [
      "cleanup_backlog_high",
      mode === "compact" ? retention.eligible_bodies : 0,
      300
    ]
  ] as const;
  for (const [reason, value, threshold] of thresholds) {
    if (value >= threshold)
      logWarn("extensions-v2", "Resource threshold exceeded", {
        reason,
        value,
        threshold
      });
  }
}

// Read-only preview: no full bodies are selected, hashed or mutated.
export async function inventoryExtensionRetention(
  db: ExtensionsDb
): Promise<{ eligible_bodies: number; reclaimable_bytes: number }> {
  const [row] = await db.all<{
    eligible_bodies: number;
    reclaimable_bytes: number;
  }>(sql`
    SELECT COUNT(*) AS eligible_bodies, COALESCE(SUM(MAX(r.content_bytes - 2, 0)), 0) AS reclaimable_bytes
    FROM extension_revisions r
    WHERE r.status IN ('approved','rejected') AND r.compacted_at IS NULL
      AND r.reviewed_at < datetime('now', ${`-${RETENTION_DAYS} days`})
      AND r.content_bytes <= ${MAX_CONTENT_BYTES}
      AND NOT EXISTS (SELECT 1 FROM extensions e WHERE e.published_revision_id=r.id)
  `);
  return row ?? { eligible_bodies: 0, reclaimable_bytes: 0 };
}
