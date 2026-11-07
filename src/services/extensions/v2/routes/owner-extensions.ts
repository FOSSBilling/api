import type { Context } from "hono";
import type { DatabaseError } from "../../../../lib/interfaces";
import {
  errorBody,
  listErrorStatus,
  listPayload,
  setContentRetryAfter,
  statusFromContentCreateError,
  statusFromContentWriteError,
  statusFromWriteErrorCode
} from "./errors";
import {
  paceContentAccount,
  requireActiveAuth,
  requireContentWrite,
  getPublisher
} from "../middleware";
import { getExtensionsDb } from "../../../../lib/db";
import { getAuth } from "../../../../lib/auth";
import { createRoute, z } from "@hono/zod-openapi";
import {
  ActiveAccountRequiredResponse,
  IdParamSchema,
  PaginationSchema,
  authErrorResponses,
  errorResponse
} from "../schemas/common";
import {
  ExtensionCreateSchema,
  ExtensionUpdateSchema
} from "../schemas/extensions";
import {
  ExtensionRevisionSchema,
  ExtensionRevisionSummarySchema,
  RevisionIdParamSchema,
  RevisionHistoryQuerySchema
} from "../schemas/revisions";
import { DeveloperProfilesDatabase } from "../db/developer-profiles";
import {
  ExtensionsDatabase,
  CreateExtensionAsPublisherInput
} from "../db/extensions";
import { ExtensionRevisionsDatabase } from "../db/revisions";
import { UsersDatabase } from "../db/users";
import { revalidateExtensions } from "../revalidate";
import { ExtensionsV2App } from "./app";

// Both history and detail authorize against current account/profile state;
// their actual data queries repeat this guard to contain mid-request changes.
async function revisionReadError(
  c: Context<{ Bindings: CloudflareBindings }>,
  identifier: string
): Promise<DatabaseError | null> {
  const db = getExtensionsDb(c.env.DB_EXTENSIONS);
  const auth = getAuth(c);
  const [ownership, access] = await Promise.all([
    new ExtensionsDatabase(db).getOwnership(identifier),
    new UsersDatabase(db).moderatorAccess(auth.userId)
  ]);
  if (ownership.error) return ownership.error;
  if (access.error) return access.error;
  if (!access.data.active)
    return { code: "ACCOUNT_INACTIVE", message: "Active account required" };
  if (ownership.data.ownerUserId !== auth.userId && !access.data.moderator)
    return { code: "FORBIDDEN", message: "You do not own this extension" };
  return null;
}

const AcceptedRevisionResultSchema = z.object({
  identifier: z.string(),
  revision_id: z.string(),
  status: z.literal("pending")
});
const AcceptedRevisionSchema = z.object({
  result: AcceptedRevisionResultSchema
});

export function registerOwnerExtensionsRoutes(app: ExtensionsV2App): void {
  const createRouteDefinition = createRoute({
    method: "post",
    path: "/extensions",
    tags: ["Extensions"],
    summary: "Create an extension and submit its first version for review",
    security: [{ Bearer: [] }],
    middleware: [requireContentWrite(), paceContentAccount()] as const,
    request: {
      body: {
        content: { "application/json": { schema: ExtensionCreateSchema } }
      }
    },
    responses: {
      201: {
        content: {
          "application/json": {
            schema: z.object({
              result: AcceptedRevisionResultSchema.extend({
                id: z.uuidv7()
              })
            })
          }
        },
        description:
          "Extension created. It holds the id immediately but stays out of the public extension listing until a moderator approves the revision."
      },
      ...authErrorResponses(),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller has no developer profile to publish under"
      },
      409: errorResponse(
        "The id is taken, ownership changed, or the pending-revision limit was reached"
      ),
      413: errorResponse("Raw request exceeds 512 KiB"),
      429: errorResponse(
        "Extension write allowance exhausted; see Retry-After"
      ),
      503: errorResponse("Write admission unavailable"),
      422: errorResponse("Body failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(createRouteDefinition, async (c) => {
    const auth = getAuth(c);
    const { identifier, ...content } = c.req.valid("json");
    const publisher = getPublisher(c);

    // A publisher client writes under its mapped developer; the mapping is
    // re-verified inside the insert. Humans resolve their own profile.
    if (publisher) {
      const input: CreateExtensionAsPublisherInput = {
        identifier,
        clientId: publisher.clientId,
        developerId: publisher.developerId,
        submittedBy: auth.userId,
        content
      };
      const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
      const { data, error } = await db.createAsPublisher(input);
      if (error || !data) {
        setContentRetryAfter(c, error?.code);
        return c.json(
          errorBody(error, "Unable to create extension"),
          statusFromContentCreateError(error?.code)
        );
      }
      return c.json(
        {
          result: {
            id: data.id,
            identifier,
            revision_id: data.revisionId,
            status: "pending" as const
          }
        },
        201
      );
    }

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
      identifier,
      developerId: owner.data.id,
      ownershipEpoch: owner.data.ownershipEpoch,
      submittedBy: auth.userId,
      content
    });
    if (error || !data) {
      setContentRetryAfter(c, error?.code);
      return c.json(
        errorBody(error, "Unable to create extension"),
        statusFromContentCreateError(error?.code)
      );
    }
    return c.json(
      {
        result: {
          id: data.id,
          identifier,
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
    middleware: [requireContentWrite(), paceContentAccount()] as const,
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
      ...authErrorResponses(),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller does not own this extension"
      },
      404: errorResponse("No extension with that id"),
      409: errorResponse(
        "An edit is already awaiting review, or the pending-revision limit was reached"
      ),
      413: errorResponse("Raw request exceeds 512 KiB"),
      429: errorResponse(
        "Extension write allowance exhausted; see Retry-After"
      ),
      503: errorResponse("Write admission unavailable"),
      422: errorResponse("Body failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(updateRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const content = c.req.valid("json");
    const publisher = getPublisher(c);
    const db = new ExtensionRevisionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = publisher
      ? await db.proposeAsPublisher({
          extensionId: id,
          clientId: publisher.clientId,
          submittedBy: auth.userId,
          developerId: publisher.developerId,
          content
        })
      : await db.propose({
          extensionId: id,
          callerId: auth.userId,
          content
        });
    if (error || !data) {
      setContentRetryAfter(c, error?.code);
      return c.json(
        errorBody(error, "Unable to submit edit"),
        statusFromContentWriteError(error?.code)
      );
    }
    return c.json(
      {
        result: {
          identifier: data.identifier,
          revision_id: data.id,
          status: "pending" as const
        }
      },
      202
    );
  });

  const replacePendingRoute = createRoute({
    method: "put",
    path: "/extensions/{id}/revisions/{revisionId}",
    tags: ["Extensions"],
    summary: "Replace a pending submission for an extension the caller owns",
    description:
      "The active owner can replace publisher-created submissions. The replacement records the owner as submitter.",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth(), paceContentAccount()] as const,
    request: {
      params: RevisionIdParamSchema,
      body: {
        content: { "application/json": { schema: ExtensionUpdateSchema } }
      }
    },
    responses: {
      202: {
        content: { "application/json": { schema: AcceptedRevisionSchema } },
        description:
          "Replaced with a new pending revision ID. Published content and reviewed history are unchanged."
      },
      ...authErrorResponses(),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller does not own this extension"
      },
      404: errorResponse("No extension with that id"),
      409: errorResponse(
        "The pending revision changed, was reviewed, ownership changed, or the pending-revision limit was reached"
      ),
      413: errorResponse("Raw request exceeds 512 KiB"),
      429: errorResponse(
        "Extension write allowance exhausted; see Retry-After"
      ),
      503: errorResponse("Write admission unavailable"),
      422: errorResponse("Body failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(replacePendingRoute, async (c) => {
    const auth = getAuth(c);
    const { id, revisionId } = c.req.valid("param");
    const content = c.req.valid("json");
    const db = new ExtensionRevisionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.replacePending({
      extensionId: id,
      revisionId,
      callerId: auth.userId,
      content
    });
    if (error || !data) {
      setContentRetryAfter(c, error?.code);
      return c.json(
        errorBody(error, "Unable to submit edit"),
        statusFromContentWriteError(error?.code)
      );
    }
    return c.json(
      {
        result: {
          identifier: data.identifier,
          revision_id: data.id,
          status: "pending" as const
        }
      },
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
              result: z.object({
                id: z.uuidv7(),
                identifier: z.string(),
                deleted: z.literal(true)
              })
            })
          }
        },
        description: "Extension and its revisions deleted, and the id released"
      },
      ...authErrorResponses(),
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
    revalidateExtensions(c);
    return c.json(
      {
        result: {
          id: data.id,
          identifier: data.identifier,
          deleted: true as const
        }
      },
      200
    );
  });

  const revisionsRoute = createRoute({
    method: "get",
    path: "/extensions/{id}/revisions",
    tags: ["Extensions"],
    summary: "List an extension's revisions, newest first",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: { params: IdParamSchema, query: RevisionHistoryQuerySchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.array(ExtensionRevisionSummarySchema),
              pagination: PaginationSchema
            })
          }
        },
        description:
          "Every version proposed for this extension, with its review outcome"
      },
      ...authErrorResponses(),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller neither owns this extension nor moderates"
      },
      404: errorResponse("No extension with that id"),
      422: errorResponse("Pagination query failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(revisionsRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");
    const accessError = await revisionReadError(c, id);
    if (accessError)
      return c.json(
        errorBody(accessError, "Unable to read revisions"),
        accessError.code === "NOT_FOUND"
          ? 404
          : accessError.code === "FORBIDDEN" ||
              accessError.code === "ACCOUNT_INACTIVE"
            ? 403
            : 500
      );

    const db = new ExtensionRevisionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.listScoped({
      extensionId: id,
      readerId: auth.userId,
      sort: "newest",
      limit,
      cursor
    });
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to load revisions"),
        listErrorStatus(error)
      );
    }
    const res = c.json(listPayload(data), 200);
    res.headers.set("Vary", "Authorization");
    return res;
  });
  const revisionDetailRoute = createRoute({
    method: "get",
    path: "/extensions/{id}/revisions/{revisionId}",
    tags: ["Extensions"],
    summary: "Read one revision; compacted content is null",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: { params: RevisionIdParamSchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: ExtensionRevisionSchema
            })
          }
        },
        description:
          "One revision with its review outcome; content is null when compacted"
      },
      ...authErrorResponses(),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller neither owns this extension nor moderates"
      },
      404: errorResponse("No extension or revision with that id"),
      409: errorResponse(
        "Oversized legacy content requires administrative export or resubmission"
      ),
      422: errorResponse("Path failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(revisionDetailRoute, async (c) => {
    const auth = getAuth(c);
    const { id, revisionId } = c.req.valid("param");
    const accessError = await revisionReadError(c, id);
    if (accessError)
      return c.json(
        errorBody(accessError, "Unable to read revisions"),
        accessError.code === "NOT_FOUND"
          ? 404
          : accessError.code === "FORBIDDEN" ||
              accessError.code === "ACCOUNT_INACTIVE"
            ? 403
            : 500
      );

    const db = new ExtensionRevisionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.getById(id, revisionId, auth.userId);
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to load revisions"),
        error?.code === "NOT_FOUND"
          ? 404
          : error?.code === "CONTENT_UNAVAILABLE"
            ? 409
            : 500
      );
    }
    const res = c.json(
      {
        result: data
      },
      200
    );
    res.headers.set("Vary", "Authorization");
    return res;
  });
}
