import type { ExtensionsDb } from "../../../../lib/db";
import { getPlatform } from "../../../../lib/middleware";
import type { Context } from "hono";
import {
  notifyRequested,
  sendModerationNotification,
  type ModerationNotifyInput
} from "../email/notify";
import { revalidateCatalogue } from "../revalidate";

// Shared tail of routes that notify authors after moderation writes: purge
// the CDN-cached catalogue pages, then — unless ?notify=false opted out —
// dispatch the author notification off the response path. Returns the
// `notified` flag the routes report in their response bodies.
// (moderatorCorrect also mutates but deliberately sends no email, so it
// calls revalidateCatalogue() directly instead of this helper.)
//
// A shared route-layer helper rather than a register*Routes module, like
// routes/errors.ts; it touches the Hono context and revalidateCatalogue, so
// it deliberately lives beside its call sites rather than in email/.
export async function notifyAuthor(
  c: Context,
  extDb: ExtensionsDb,
  query: { notify?: string },
  input: ModerationNotifyInput
): Promise<boolean> {
  revalidateCatalogue(c);
  if (!notifyRequested(query)) return false;
  return sendModerationNotification(getPlatform(c), extDb, input, (p) =>
    c.executionCtx.waitUntil(p)
  );
}
