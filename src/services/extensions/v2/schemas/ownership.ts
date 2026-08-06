import { z } from "@hono/zod-openapi";

export const TransferAcceptanceSchema = z
  .object({ token: z.string().min(64).max(128) })
  .strict()
  .openapi("TransferAcceptance");

export const DeveloperTransferSchema = z
  .object({
    token: z.string(),
    expires_at: z.string()
  })
  .openapi("DeveloperTransfer");

export type DeveloperTransfer = z.infer<typeof DeveloperTransferSchema>;

export const DeveloperClaimSchema = z
  .object({
    id: z.string(),
    developer_id: z.string(),
    claimant_id: z.string(),
    status: z.enum(["pending", "approved", "rejected"]),
    note: z.string().optional(),
    review_note: z.string().optional(),
    reviewer_id: z.string().optional(),
    created_at: z.string(),
    reviewed_at: z.string().optional(),
    // Server-computed at claim() time only — never accepted from the
    // client (see ClaimNoteSchema below). Undefined when there was no
    // verifiable GitHub org/user for this id, or the claimant had no linked
    // GitHub identity yet; both fall back to manual moderator review. An
    // absent value is not proof of ownership and must not bypass approval.
    github_org_verified: z.boolean().optional(),
    github_verification_note: z.string().optional()
  })
  .openapi("DeveloperClaim");

export type DeveloperClaim = z.infer<typeof DeveloperClaimSchema>;

export const PendingDeveloperClaimSchema = DeveloperClaimSchema.extend({
  developer_name: z.string(),
  developer_type: z.enum(["user", "organization"]),
  // The claimant's own account name/GitHub handle, so the moderator sees
  // who's asking instead of just their opaque id. Null if the auth
  // provider never gave a name, or the claimant hasn't linked GitHub yet.
  claimant_name: z.string().nullable(),
  claimant_github_login: z.string().nullable()
}).openapi("PendingDeveloperClaim");

export type PendingDeveloperClaim = z.infer<typeof PendingDeveloperClaimSchema>;

// strict: the claim route's server-side fields (github_org_verified and
// friends, on DeveloperClaimSchema above) are computed at claim() time and
// must never be accepted from the client, so an unknown key here is a mistake
// worth reporting rather than silently dropping.
export const ClaimNoteSchema = z
  .object({
    note: z.string().max(500).optional()
  })
  .strict()
  .openapi("ClaimNote");
