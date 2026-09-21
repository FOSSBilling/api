import { z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import type { ExtensionsDb } from "../../../../lib/db";
import { developers, extensions, users } from "../db/schema";

// Same constraints as the input schemas (DeveloperInputSchema's
// contact_email, UserIdentityInputSchema's email): a legacy stored value that
// merely contains "@" must not suppress the account-email fallback.
const emailSchema = z.string().email().max(254);

function isEmail(value: unknown): value is string {
  return emailSchema.safeParse(value).success;
}

// Developer contact email wins; the owner's account email is the fallback.
// Either may be missing (legacy/unclaimed profiles, auth without email).
function pickEmail(
  contactEmail: string | null,
  accountEmail: string | null
): string | null {
  if (contactEmail && isEmail(contactEmail)) return contactEmail;
  if (accountEmail && isEmail(accountEmail)) return accountEmail;
  return null;
}

// Notification only needs the extension name and the developer's address,
// so one join answers it - the heavy owned view (revision joins,
// pendingContent) and its serial lookups add nothing here.
export async function resolveExtensionEmail(
  db: ExtensionsDb,
  extensionId: string
): Promise<{
  to: string;
  extensionName?: string;
  developerId: string;
  developerName?: string;
} | null> {
  try {
    const [row] = await db
      .select({
        extensionName: extensions.name,
        developerId: extensions.developerId,
        developerName: developers.name,
        contactEmail: developers.contactEmail,
        accountEmail: users.email
      })
      .from(extensions)
      .innerJoin(developers, eq(extensions.developerId, developers.id))
      .leftJoin(users, eq(developers.ownerUserId, users.id))
      // Moderation routes pass the raw URL param, and ids are matched
      // case-insensitively everywhere else (LOWER(id) = LOWER(id)) - mixed
      // case is a supported input, not a miss.
      .where(sql`LOWER(${extensions.id}) = LOWER(${extensionId})`);

    if (!row) return null;

    const to = pickEmail(row.contactEmail, row.accountEmail);
    if (!to) return null;

    return {
      to,
      extensionName: row.extensionName ?? undefined,
      developerId: row.developerId,
      developerName: row.developerName
    };
  } catch {
    return null;
  }
}

export async function resolveDeveloperProfileEmail(
  db: ExtensionsDb,
  developerId: string
): Promise<{ to: string; developerName?: string } | null> {
  try {
    const [row] = await db
      .select({
        developerName: developers.name,
        contactEmail: developers.contactEmail,
        accountEmail: users.email
      })
      .from(developers)
      .leftJoin(users, eq(developers.ownerUserId, users.id))
      .where(eq(developers.id, developerId));

    if (!row) return null;

    const to = pickEmail(row.contactEmail, row.accountEmail);
    if (!to) return null;
    return { to, developerName: row.developerName };
  } catch {
    return null;
  }
}

export async function resolveClaimantEmail(
  db: ExtensionsDb,
  claimantId: string
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, claimantId));
    return isEmail(row?.email) ? row.email : null;
  } catch {
    return null;
  }
}
