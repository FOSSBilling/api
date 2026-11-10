import { z } from "@hono/zod-openapi";

// A publisher client id is the central auth service's OAuth client_id (a
// 32-character id in practice). Bounded like other path ids so a long junk
// value cannot become a storage key.
export const PublisherClientIdParamSchema = z.object({
  client_id: z
    .string()
    .min(1)
    .max(100)
    .openapi({
      param: { name: "client_id", in: "path" },
      example: "modules-publisher"
    })
});

// Moderators bind a machine client to one developer profile. can_publish
// grants the auto-approval carve-out (the client may approve its own
// developer's pending revisions); without it the client may only propose.
export const PublisherRegisterSchema = z
  .object({
    developer_id: z.uuidv7(),
    can_publish: z.boolean().default(false)
  })
  .strict()
  .openapi("PublisherRegister");

export const PublisherClientSchema = z
  .object({
    client_id: z.string(),
    developer_id: z.uuidv7(),
    can_publish: z.boolean(),
    created_at: z.string(),
    revoked_at: z.string().nullable()
  })
  .openapi("PublisherClient");
