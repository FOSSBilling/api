import { z } from "@hono/zod-openapi";

// The site remains responsible for OIDC and sessions. It sends only the
// provider projection needed by the API-owned domain row; authorization
// fields such as is_moderator are never accepted from this payload.
export const UserIdentityInputSchema = z
  .object({
    name: z.string().max(200).nullable(),
    email: z.string().email().max(254).nullable(),
    email_verified: z.boolean(),
    picture: z.string().max(2048).nullable(),
    github_login: z.string().max(200).nullable(),
    github_orgs: z.array(z.string().max(200)).max(500).nullable(),
    github_orgs_expires_at: z.string().max(64).nullable()
  })
  .strict()
  .openapi("UserIdentityInput");

export type UserIdentityInput = z.infer<typeof UserIdentityInputSchema>;

export const UserProfileUpdateSchema = z
  .object({
    display_name: z.string().max(120).nullable()
  })
  .strict()
  .openapi("UserProfileUpdate");

export const UserSchema = z
  .object({
    display_name: z.string().nullable(),
    is_moderator: z.boolean(),
    github_linked: z.boolean(),
    active: z.boolean()
  })
  .openapi("User");

export type User = z.infer<typeof UserSchema>;
