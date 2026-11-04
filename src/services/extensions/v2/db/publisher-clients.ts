import { eq } from "drizzle-orm";
import { DatabaseResult } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { publisherClients } from "./schema";
import { databaseError } from "./errors";

export interface PublisherClient {
  clientId: string;
  developerId: string;
  serviceUserId: string;
  canPublish: boolean;
}

// Reads the API-side authorization for an auth-issued machine client: which
// developer it may publish for, which service user its writes are attributed
// to, and whether it may approve (publish) or only propose revisions.
// Revoked rows read as absent — past revisions keep their history, but the
// client authenticates no further requests.
export class PublisherClientsDatabase {
  constructor(private db: ExtensionsDb) {}

  async getActive(clientId: string): Promise<DatabaseResult<PublisherClient>> {
    try {
      const [row] = await this.db
        .select({
          clientId: publisherClients.clientId,
          developerId: publisherClients.developerId,
          serviceUserId: publisherClients.serviceUserId,
          canPublish: publisherClients.canPublish,
          revokedAt: publisherClients.revokedAt
        })
        .from(publisherClients)
        .where(eq(publisherClients.clientId, clientId));
      if (!row || row.revokedAt !== null) {
        return {
          data: null,
          error: { message: "Unknown publisher client", code: "NOT_FOUND" }
        };
      }
      return {
        data: {
          clientId: row.clientId,
          developerId: row.developerId,
          serviceUserId: row.serviceUserId,
          canPublish: row.canPublish === 1
        },
        error: null
      };
    } catch (error) {
      return databaseError("publisherClients.getActive", error);
    }
  }
}
