import type { ExtensionsDb } from "../../../../lib/db";
import { getPlatform } from "../../../../lib/middleware";
import type { Context } from "hono";
import {
  notifyRequested,
  sendModerationNotification,
  type ModerationNotifyInput
} from "../email/notify";
import { revalidateCatalogue } from "../revalidate";

// The shared tail of every mutating moderation route: purge the CDN-cached
// catalogue pages, then — unless ?notify=false opted out — dispatch the
// author notification off the response path. Returns the `notified` flag the
// routes report in their response bodies.
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
