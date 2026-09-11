import { eq } from "drizzle-orm";
import type { ExtensionsDb } from "../../../../lib/db";
import { developers, users } from "../db/schema";
import { DeveloperProfilesDatabase } from "../db/developer-profiles";
import { ExtensionsDatabase } from "../db/extensions";

function isEmail(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 254) return false;
  const at = value.indexOf("@");
  return (
    at > 0 &&
    at === value.lastIndexOf("@") &&
    at < value.length - 1 &&
    !/[\s,;<>()[\]\\]/.test(value)
  );
}

async function getUserEmail(
  db: ExtensionsDb,
  userId: string
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    return isEmail(row?.email) ? row.email : null;
  } catch {
    return null;
  }
}

// Developer contact email wins; the owner's account email is the fallback.
// Either may be missing (legacy/unclaimed profiles, auth without email).
async function resolveDeveloperEmail(
  db: ExtensionsDb,
  developerId: string,
  contact: string | null
): Promise<string | null> {
  if (contact) return contact;

  try {
    const [row] = await db
      .select({ ownerUserId: developers.ownerUserId })
      .from(developers)
      .where(eq(developers.id, developerId));
    if (row?.ownerUserId) {
      return getUserEmail(db, row.ownerUserId);
    }
  } catch {
    return null;
  }
  return null;
}

export async function resolveExtensionEmail(
  db: ExtensionsDb,
  extensionId: string
): Promise<{
  to: string;
  extensionName?: string;
  developerId: string;
  developerName?: string;
} | null> {
  const extensions = new ExtensionsDatabase(db);
  const { data } = await extensions.getOwned(extensionId);
  if (!data) return null;

  const profiles = new DeveloperProfilesDatabase(db);
  const { data: profile } = await profiles.getById(data.extension.developer.id);
  const contact =
    profile && isEmail(profile.contact_email) ? profile.contact_email : null;
  const to = await resolveDeveloperEmail(
    db,
    data.extension.developer.id,
    contact
  );
  if (!to) return null;

  return {
    to,
    extensionName: data.extension.published?.name,
    developerId: data.extension.developer.id,
    developerName: data.extension.developer.name
  };
}

export async function resolveDeveloperProfileEmail(
  db: ExtensionsDb,
  developerId: string
): Promise<{ to: string; developerName?: string } | null> {
  const profiles = new DeveloperProfilesDatabase(db);
  const { data } = await profiles.getById(developerId);
  if (!data) return null;

  const contact = isEmail(data.contact_email) ? data.contact_email : null;
  const to = await resolveDeveloperEmail(db, developerId, contact);
  if (!to) return null;
  return { to, developerName: data.name };
}

export async function resolveClaimantEmail(
  db: ExtensionsDb,
  claimantId: string
): Promise<string | null> {
  return getUserEmail(db, claimantId);
}
