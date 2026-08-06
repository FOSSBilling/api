import { z } from "@hono/zod-openapi";
import { httpUrl, lowercaseId } from "./common";

// GET /developers/{id} is registered after the static single-segment
// GET /developers/* routes (claims, me, unapproved), so a developer whose id
// literally matched one of those words would always hit the static route
// instead. Rejecting these ids at creation time keeps new profiles
// resolvable; adopted rows cannot be renamed by a schema, so they are
// covered by the pre-deploy check in the service README.
const RESERVED_DEVELOPER_IDS = new Set(["claims", "me", "unapproved"]);

// Exported so the approval boundary can reuse it: submissions store their
// payload as JSON and are re-read without re-running this schema, so the one
// check has to be callable from there too. Lowercases like
// isReservedExtensionId, since route matching is case-sensitive but these
// literals are not.
export function isReservedDeveloperId(id: string): boolean {
  return RESERVED_DEVELOPER_IDS.has(id.toLowerCase());
}

const developerId = () =>
  lowercaseId("developer").refine((id) => !isReservedDeveloperId(id), {
    message: "This developer id is reserved"
  });

export const DeveloperSchema = z
  .object({
    id: developerId(),
    type: z.enum(["user", "organization"]),
    name: z.string().min(1).max(120),
    URL: httpUrl().optional(),
    avatar_url: httpUrl().optional(),
    contact_email: z.string().email().max(254).optional()
  })
  .openapi("Developer");

export type Developer = z.infer<typeof DeveloperSchema>;

// Submissions go through moderation and only ever touch identity fields —
// profile fields (avatar_url/contact_email) are direct-write-only via
// PUT /developers/me, so this schema rejects them instead of silently
// accepting-then-dropping them when a submission is approved.
export const SubmissionDeveloperSchema = DeveloperSchema.pick({
  id: true,
  type: true,
  name: true,
  URL: true
})
  .strict()
  .openapi("SubmissionDeveloper");

export const DeveloperProfileSchema = DeveloperSchema.extend({
  approved: z.boolean(),
  content_revision: z.int().positive(),
  // Server-computed — see verifyGithubOwnership() (at
  // claim/creation time) and reverifyOwn() (opportunistic re-check on
  // login, or the owner's own "Re-verify" action). Never part of the
  // client-supplied DeveloperSchema.
  github_org_verified: z.boolean().optional(),
  github_verification_note: z.string().optional(),
  // Set whenever github_org_verified is last (re-)computed to a definitive
  // true/false — see reverifyOwn(). Absent/stale on an inconclusive check.
  github_verified_at: z.string().nullish(),
  // Whether Publisher URL matches GitHub's own on-file website for this
  // org/user — see verifyGithubOwnership()'s urlMatchesGithubBlog() call.
  // Only ever true or absent (never false): GitHub's website field is
  // optional and often unset, so "doesn't match" isn't itself meaningful —
  // there's nothing to flag, unlike github_org_verified's identity check.
  // Computed at creation, and re-checked by the owner's own "Re-verify"
  // action (never by the opportunistic per-login re-check, which stays
  // GitHub-API-free by design).
  github_url_verified: z.boolean().optional(),
  // Only populated by the moderator listAll/listUnapproved queries (see
  // DeveloperProfilesDatabase.listAll/listUnapproved) — other DeveloperProfile
  // producers (getById, create/update/claim/transfer results) don't join
  // for it, so it's absent rather than null there. `unclaimed` is the
  // authoritative "has an owner" signal (owner_user_id IS NULL) — don't
  // infer ownership from owner_name being present, since a real owner can
  // still have a null name (e.g. their auth provider never supplied one).
  // Owner identity is never exposed publicly — see PublicDeveloperSchema
  // below and the README's note on not leaking owner identity.
  unclaimed: z.boolean().optional(),
  owner_name: z.string().nullish(),
  owner_github_login: z.string().nullish()
}).openapi("DeveloperProfile");

export type DeveloperProfile = z.infer<typeof DeveloperProfileSchema>;

// The publicly-readable view of a developer profile: everything in
// DeveloperProfile except contact_email/content_revision (moderator/owner
// only), the GitHub verification signal (a moderator-review aid, not meant
// for public consumption), and the owner's identity (only ever an
// `unclaimed` boolean is public). The Extensions site consumes this
// projection through the generated API client.
export const PublicDeveloperSchema = DeveloperProfileSchema.omit({
  contact_email: true,
  content_revision: true,
  github_org_verified: true,
  github_verification_note: true,
  github_verified_at: true,
  github_url_verified: true,
  owner_name: true,
  owner_github_login: true
})
  .extend({ unclaimed: z.boolean() })
  .openapi("PublicDeveloper");

export type PublicDeveloper = z.infer<typeof PublicDeveloperSchema>;

export function toPublicDeveloper(
  profile: DeveloperProfile & { unclaimed: boolean }
): PublicDeveloper {
  return {
    id: profile.id,
    type: profile.type,
    name: profile.name,
    URL: profile.URL,
    avatar_url: profile.avatar_url,
    approved: profile.approved,
    unclaimed: profile.unclaimed
  };
}

export const OwnedDeveloperProfileSchema = z
  .intersection(
    DeveloperProfileSchema,
    z.object({ has_pending_transfer: z.boolean() })
  )
  .openapi("OwnedDeveloperProfile");

export const DeveloperHistoryEntrySchema = z
  .object({
    developer_id: z.string(),
    type: z.enum(["user", "organization"]),
    name: z.string(),
    URL: httpUrl().optional(),
    changed_by: z.string(),
    // The editor's account name at read time — null if the auth provider
    // never gave one, or the users row was since deleted.
    changed_by_name: z.string().nullable(),
    changed_at: z.string()
  })
  .openapi("DeveloperHistoryEntry");

export type DeveloperHistoryEntry = z.infer<typeof DeveloperHistoryEntrySchema>;

export const DeveloperApprovalSchema = z
  .object({ expected_revision: z.number().int().positive() })
  .strict()
  .openapi("DeveloperApproval");

// check_url — opt-in because it costs an extra GitHub API call (see
// DeveloperProfilesDatabase.reverifyOwn()); only the owner's own manual "Re-verify"
// button sets this, never the opportunistic per-login re-check. Not
// z.coerce.boolean(): that coerces the non-empty string "false" to true.
export const ReverifyQuerySchema = z.object({
  check_url: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true")
    .openapi({
      param: { name: "check_url", in: "query" }
    })
});
