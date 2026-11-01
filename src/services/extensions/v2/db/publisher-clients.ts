import { and, desc, eq, sql } from "drizzle-orm";
import { DatabaseResult } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { databaseError } from "./errors";
import { developers, m2mPublisherClients } from "./schema";
import { toD1Statement } from "./batch";

// Id of the synthetic `users` projection row backing a registered client.
// It is not an account: no sign-in can reach it (the id does not come from
// the central auth service), and it never owns a developer profile. It
// anchors the `users` foreign keys on the revisions the client submits and
// approves, and gives the write budgets and audit columns a stable subject.
export function m2mProjectUserId(clientId: string): string {
  return `m2m:${clientId}`;
}

export interface RegisteredPublisher {
  clientId: string;
  developerId: string;
  canPublish: boolean;
  ownershipEpoch: number;
  createdAt: string;
  revokedAt: string | null;
}

interface PublisherRow {
  clientId: string;
  developerId: string;
  canPublish: number;
  ownershipEpoch: number;
  createdAt: string;
  revokedAt: string | null;
}

function parsePublisherRow(row: PublisherRow): RegisteredPublisher {
  return {
    clientId: row.clientId,
    developerId: row.developerId,
    canPublish: row.canPublish === 1,
    ownershipEpoch: row.ownershipEpoch,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt
  };
}

export class PublisherClientsDatabase {
  constructor(private db: ExtensionsDb) {}

  // Resolves an active (never revoked) mapping. The routes call this per
  // request, so a revoked client loses access without waiting out a token.
  async getActive(
    clientId: string
  ): Promise<DatabaseResult<RegisteredPublisher | null>> {
    try {
      const [row] = await this.db
        .select()
        .from(m2mPublisherClients)
        .where(
          and(
            eq(m2mPublisherClients.clientId, clientId),
            sql`${m2mPublisherClients.revokedAt} IS NULL`
          )
        );
      return { data: row ? parsePublisherRow(row) : null, error: null };
    } catch (error) {
      return databaseError("getActive", error);
    }
  }

  async list(): Promise<DatabaseResult<RegisteredPublisher[]>> {
    try {
      const rows = await this.db
        .select()
        .from(m2mPublisherClients)
        .orderBy(desc(m2mPublisherClients.createdAt));
      return { data: rows.map(parsePublisherRow), error: null };
    } catch (error) {
      return databaseError("list", error);
    }
  }

  // Registers or re-registers a client against a developer, binding to the
  // developer's CURRENT ownership epoch. Re-registration is also the
  // un-revoke and the rebind path: revoked_at clears and the mapping fields
  // (including the epoch) are replaced, so after an ownership transfer a
  // moderator must re-register before the client writes again. The synthetic
  // users projection row is ensured in the same batch; it must exist before
  // the client can submit or approve anything (foreign keys).
  async register(input: {
    clientId: string;
    developerId: string;
    canPublish: boolean;
  }): Promise<DatabaseResult<RegisteredPublisher>> {
    const now = new Date().toISOString();
    try {
      await this.db.$client.batch([
        toD1Statement(this.db.$client, {
          sql: `INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)
                ON CONFLICT (id) DO NOTHING`,
          params: [m2mProjectUserId(input.clientId), now, now]
        }),
        toD1Statement(this.db.$client, {
          sql: `INSERT INTO m2m_publisher_clients
                  (client_id, developer_id, can_publish, ownership_epoch, created_at, revoked_at)
                SELECT ?, ?, ?, d.ownership_epoch, ?, NULL
                FROM developers d
                WHERE d.id = ?
                ON CONFLICT (client_id) DO UPDATE SET
                  developer_id = excluded.developer_id,
                  can_publish = excluded.can_publish,
                  ownership_epoch = excluded.ownership_epoch,
                  revoked_at = NULL`,
          params: [
            input.clientId,
            input.developerId,
            input.canPublish ? 1 : 0,
            now,
            input.developerId
          ]
        })
      ]);
    } catch (error) {
      return databaseError("register", error);
    }
    const read = await this.getActive(input.clientId);
    if (read.error || !read.data) {
      return {
        data: null,
        error: read.error ?? {
          message: "Mapping was not registered",
          code: "CONFLICT"
        }
      };
    }
    return { data: read.data, error: null };
  }

  // Soft-revokes: the row stays for audit, lookups stop matching, and the
  // synthetic user remains because historical revisions reference it.
  async revoke(
    clientId: string
  ): Promise<DatabaseResult<{ revoked: boolean }>> {
    try {
      const result = await this.db
        .update(m2mPublisherClients)
        .set({ revokedAt: new Date().toISOString() })
        .where(
          and(
            eq(m2mPublisherClients.clientId, clientId),
            sql`${m2mPublisherClients.revokedAt} IS NULL`
          )
        );
      return { data: { revoked: result.meta.changes > 0 }, error: null };
    } catch (error) {
      return databaseError("revoke", error);
    }
  }

  // Developer binding + publish flag of an active mapping, with whether the
  // binding has gone stale (the developer's ownership epoch moved since
  // registration — an ownership transfer). Null when the mapping is missing,
  // revoked, or its developer row is gone (inner join).
  async getActiveRef(clientId: string): Promise<
    DatabaseResult<{
      developerId: string;
      ownershipEpoch: number;
      canPublish: boolean;
      stale: boolean;
    } | null>
  > {
    try {
      const [row] = await this.db
        .select({
          developerId: m2mPublisherClients.developerId,
          canPublish: m2mPublisherClients.canPublish,
          ownershipEpoch: m2mPublisherClients.ownershipEpoch,
          developerEpoch: developers.ownershipEpoch
        })
        .from(m2mPublisherClients)
        .innerJoin(
          developers,
          eq(developers.id, m2mPublisherClients.developerId)
        )
        .where(
          and(
            eq(m2mPublisherClients.clientId, clientId),
            sql`${m2mPublisherClients.revokedAt} IS NULL`
          )
        );
      return {
        data: row
          ? {
              developerId: row.developerId,
              ownershipEpoch: row.ownershipEpoch,
              canPublish: row.canPublish === 1,
              stale: row.developerEpoch !== row.ownershipEpoch
            }
          : null,
        error: null
      };
    } catch (error) {
      return databaseError("getActiveRef", error);
    }
  }
}
