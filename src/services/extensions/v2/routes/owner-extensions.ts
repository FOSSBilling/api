import { errorBody, statusFromWriteErrorCode } from "./errors";
import { requireActiveAuth } from "../middleware";
import { getExtensionsDb } from "../../../../lib/db";
import { getAuth } from "../../../../lib/auth";
import { createRoute, z } from "@hono/zod-openapi";
import {
  ActiveAccountRequiredResponse,
  IdParamSchema,
  errorResponse
} from "../schemas/common";
import {
  ExtensionCreateSchema,
  ExtensionUpdateSchema
} from "../schemas/extensions";
import { DeveloperProfilesDatabase } from "../db/developer-profiles";
import { ExtensionsDatabase } from "../db/extensions";
import { ExtensionRevisionsDatabase } from "../db/revisions";
import { ExtensionsV2App } from "./app";

const AcceptedRevisionSchema = z.object({
  result: z.object({
    id: z.string(),
    revision_id: z.string(),
    status: z.literal("pending")
  })
});

export function registerOwnerExtensionsRoutes(app: ExtensionsV2App): void {
  const createRouteDefinition = createRoute({
    method: "post",
    path: "/extensions",
    tags: ["Extensions"],
    summary: "Create an extension and submit its first version for review",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: {
      body: {
        content: { "application/json": { schema: ExtensionCreateSchema } }
      }
    },
    responses: {
      201: {
        content: { "application/json": { schema: AcceptedRevisionSchema } },
        description:
          "Extension created. It holds the id immediately but stays out of the public catalogue until a moderator approves the revision."
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller has no developer profile to publish under"
      },
      409: errorResponse(
        "The id is taken, ownership changed, or the pending-revision limit was reached"
      ),
      422: errorResponse("Body failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(createRouteDefinition, async (c) => {
    const auth = getAuth(c);
    const { id, ...content } = c.req.valid("json");

    const owner = await new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    ).getOwnRef(auth.userId);
    if (owner.error) {
      return c.json(errorBody(owner.error, "Unable to load developer"), 500);
    }
    if (!owner.data) {
      return c.json(
        {
          error: {
            message:
              "You need a developer profile before publishing — create one with PUT /developers/me",
            code: "FORBIDDEN"
          }
        },
        403
      );
    }

    const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const { data, error } = await db.create({
      extensionId: id,
      developerId: owner.data.id,
      ownershipEpoch: owner.data.ownershipEpoch,
      submittedBy: auth.userId,
      content
    });
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to create extension"),
        statusFromWriteErrorCode(error?.code, false)
      );
    }
    return c.json(
      {
        result: {
          id: data.id,
          revision_id: data.revisionId,
          status: "pending" as const
        }
      },
      201
    );
  });

  const updateRoute = createRoute({
    method: "put",
    path: "/extensions/{id}",
    tags: ["Extensions"],
    summary: "Submit an edit to an extension the caller owns",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: {
      params: IdParamSchema,
      body: {
        content: { "application/json": { schema: ExtensionUpdateSchema } }
      }
    },
    responses: {
      202: {
        content: { "application/json": { schema: AcceptedRevisionSchema } },
        description:
          "Edit accepted as a pending revision. The published content is unchanged until a moderator approves it."
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller does not own this extension"
      },
      404: errorResponse("No extension with that id"),
      409: errorResponse(
        "An edit is already awaiting review, or the pending-revision limit was reached"
      ),
      422: errorResponse("Body failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(updateRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const content = c.req.valid("json");
    const db = new ExtensionRevisionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.propose({
      extensionId: id,
      callerId: auth.userId,
      content
    });
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to submit edit"),
        statusFromWriteErrorCode(error?.code)
      );
    }
    return c.json(
      { result: { id, revision_id: data.id, status: "pending" as const } },
      202
    );
  });

  const withdrawRoute = createRoute({
    method: "delete",
    path: "/extensions/{id}",
    tags: ["Extensions"],
    summary: "Withdraw an extension that has never been published",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.object({ id: z.string(), deleted: z.literal(true) })
            })
          }
        },
        description: "Extension and its revisions deleted, and the id released"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller does not own this extension"
      },
      404: errorResponse("No extension with that id"),
      409: errorResponse("The extension is published and cannot be withdrawn"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(withdrawRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const { data, error } = await db.withdraw(id, auth.userId);
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to withdraw extension"),
        statusFromWriteErrorCode(error?.code)
      );
    }
    return c.json({ result: { id: data.id, deleted: true as const } }, 200);
  });
}
