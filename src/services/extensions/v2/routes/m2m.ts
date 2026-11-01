import { requireModerator } from "../middleware";
import { getExtensionsDb } from "../../../../lib/db";
import { createRoute, z } from "@hono/zod-openapi";
import { errorBody } from "./errors";
import {
  errorResponse,
  authErrorResponses,
  ModeratorForbiddenResponse
} from "../schemas/common";
import {
  PublisherClientIdParamSchema,
  PublisherClientSchema,
  PublisherRegisterSchema
} from "../schemas/m2m";
import { PublisherClientsDatabase } from "../db/publisher-clients";
import { DeveloperProfilesDatabase } from "../db/developer-profiles";
import { ExtensionsV2App } from "./app";

// Moderators bind machine clients (the central auth service's OAuth
// client_ids) to one developer profile. Registration also ensures the
// client's synthetic users projection row, which anchors the foreign keys on
// the revisions it submits and approves. See the service README's
// "Machine publishing" section for the cross-repo setup order.
export function registerM2mRoutes(app: ExtensionsV2App): void {
  const registerRoute = createRoute({
    method: "put",
    path: "/m2m/clients/{client_id}",
    tags: ["Moderation"],
    summary:
      "Register or re-register a publisher client for a developer profile",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    request: {
      params: PublisherClientIdParamSchema,
      body: {
        content: { "application/json": { schema: PublisherRegisterSchema } }
      }
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: PublisherClientSchema })
          }
        },
        description:
          "Mapping stored. Re-registering an existing or revoked client replaces its developer binding, publish flag, and revocation."
      },
      ...authErrorResponses(ModeratorForbiddenResponse),
      404: errorResponse("No developer with that id"),
      422: errorResponse("Path params or body failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(registerRoute, async (c) => {
    const { client_id } = c.req.valid("param");
    const { developer_id, can_publish } = c.req.valid("json");
    const extDb = getExtensionsDb(c.env.DB_EXTENSIONS);

    // Pre-checked rather than surfacing the foreign-key violation as a 500.
    // Unclaimed profiles are rejected too: a publisher can only write for a
    // developer with an active owner account.
    const developer = await new DeveloperProfilesDatabase(extDb).getById(
      developer_id
    );
    if (developer.error || !developer.data || developer.data.unclaimed) {
      return c.json(
        {
          error: {
            message: "No claimed developer with that id",
            code: "NOT_FOUND"
          }
        },
        404
      );
    }

    const publishers = new PublisherClientsDatabase(extDb);
    const { data, error } = await publishers.register({
      clientId: client_id,
      developerId: developer_id,
      canPublish: can_publish
    });
    if (error || !data) {
      return c.json(errorBody(error, "Unable to register publisher"), 500);
    }
    return c.json(
      {
        result: {
          client_id: data.clientId,
          developer_id: data.developerId,
          can_publish: data.canPublish,
          created_at: data.createdAt,
          revoked_at: data.revokedAt
        }
      },
      200
    );
  });

  const revokeRoute = createRoute({
    method: "delete",
    path: "/m2m/clients/{client_id}",
    tags: ["Moderation"],
    summary: "Revoke a publisher client's mapping",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    request: { params: PublisherClientIdParamSchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.object({
                client_id: z.string(),
                revoked: z.literal(true)
              })
            })
          }
        },
        description:
          "Mapping revoked. Existing tokens keep verifying but fail authorization on the next write."
      },
      ...authErrorResponses(ModeratorForbiddenResponse),
      404: errorResponse("No active mapping for that client"),
      422: errorResponse("Path params failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(revokeRoute, async (c) => {
    const { client_id } = c.req.valid("param");
    const publishers = new PublisherClientsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await publishers.revoke(client_id);
    if (error) {
      return c.json(errorBody(error, "Unable to revoke publisher"), 500);
    }
    if (!data?.revoked) {
      return c.json(
        {
          error: {
            message: "No active mapping for that client",
            code: "NOT_FOUND"
          }
        },
        404
      );
    }
    return c.json({ result: { client_id, revoked: true as const } }, 200);
  });

  const listRoute = createRoute({
    method: "get",
    path: "/m2m/clients",
    tags: ["Moderation"],
    summary: "List registered publisher clients",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: z.array(PublisherClientSchema) })
          }
        },
        description: "Every mapping, newest first, revoked ones included"
      },
      ...authErrorResponses(ModeratorForbiddenResponse),
      500: errorResponse("Database error")
    }
  });

  app.openapi(listRoute, async (c) => {
    const publishers = new PublisherClientsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await publishers.list();
    if (error || !data) {
      return c.json(errorBody(error, "Unable to list publishers"), 500);
    }
    return c.json(
      {
        result: data.map((row) => ({
          client_id: row.clientId,
          developer_id: row.developerId,
          can_publish: row.canPublish,
          created_at: row.createdAt,
          revoked_at: row.revokedAt
        }))
      },
      200
    );
  });
}
