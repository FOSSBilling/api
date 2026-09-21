import type { ExtensionsDb } from "../../../../lib/db";
import { logError } from "../../../../lib/logger";
import { createEmailSender, DisabledSender } from "./factory";
import {
  resolveClaimantEmail,
  resolveDeveloperProfileEmail,
  resolveExtensionEmail
} from "./recipients";
import { buildModerationEmail, type ModerationEmailKind } from "./templates";
import type { EnvReader } from "./types";

export interface ModerationNotifyInput {
  kind: ModerationEmailKind;
  extensionId?: string;
  developerId?: string;
  claimantId?: string;
  reason?: string;
}

// Resolves the recipient, builds the template and sends. Never throws:
// moderation writes must succeed even when mail is unconfigured, the address
// is missing, or the provider is down. Every skip/failure is logged.
//
// Recipient resolution stays on the response path (its result is what
// `notified` reports); when the caller provides waitUntil, the provider POST
// is deferred out of the response - its 10s abort timeout is not worth
// blocking a moderation write on. `true` then means "recipient resolved and
// send dispatched", not "delivered"; delivery failures surface only in logs.
export async function sendModerationNotification(
  env: EnvReader,
  db: ExtensionsDb,
  input: ModerationNotifyInput,
  waitUntil?: (promise: Promise<unknown>) => void
): Promise<boolean> {
  try {
    let to: string | null;
    let extensionName: string | undefined;
    let developerName: string | undefined;
    let developerId = input.developerId;

    if (input.kind === "claim-approved" || input.kind === "claim-rejected") {
      if (!input.claimantId) {
        logError("email", "Claim notification missing claimant", {
          kind: input.kind,
          developerId: input.developerId
        });
        return false;
      }
      // Two independent single-row reads - resolve them together rather
      // than serializing an extra round trip onto every claim moderation.
      const [claimantEmail, developerEmail] = await Promise.all([
        resolveClaimantEmail(db, input.claimantId),
        input.developerId
          ? resolveDeveloperProfileEmail(db, input.developerId)
          : Promise.resolve(null)
      ]);
      to = claimantEmail;
      if (!to) {
        logError("email", "No address for claim notification", {
          developerId: input.developerId
        });
        return false;
      }
      developerName = developerEmail?.developerName;
    } else if (input.extensionId) {
      const recipient = await resolveExtensionEmail(db, input.extensionId);
      if (!recipient) {
        logError("email", "No address for extension notification", {
          extensionId: input.extensionId,
          kind: input.kind
        });
        return false;
      }
      to = recipient.to;
      extensionName = recipient.extensionName;
      developerId = recipient.developerId;
      developerName = recipient.developerName;
    } else if (input.developerId) {
      const recipient = await resolveDeveloperProfileEmail(
        db,
        input.developerId
      );
      if (!recipient) {
        logError("email", "No address for developer notification", {
          developerId: input.developerId,
          kind: input.kind
        });
        return false;
      }
      to = recipient.to;
      developerName = recipient.developerName;
    } else {
      logError("email", "Notification missing extension and developer", {
        kind: input.kind
      });
      return false;
    }

    const message = buildModerationEmail({
      kind: input.kind,
      to,
      extensionId: input.extensionId,
      extensionName,
      developerId,
      developerName,
      reason: input.reason
    });

    const sender = createEmailSender(env);
    // An unconfigured or incomplete provider cannot dispatch anything:
    // report notified:false up front rather than handing a doomed send to
    // waitUntil, so the flag keeps meaning "a real send was dispatched".
    if (sender instanceof DisabledSender) {
      logError("email", "Moderation notification skipped: email not sent", {
        kind: input.kind,
        reason: sender.reason
      });
      return false;
    }
    const send = (async () => {
      try {
        const result = await sender.send(message);
        if (!result.ok) {
          logError("email", "Moderation notification failed", {
            kind: input.kind,
            error: result.error
          });
          return false;
        }
        return true;
      } catch (error) {
        logError("email", "Moderation notification error", {
          message: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    })();

    if (waitUntil) {
      waitUntil(send);
      return true;
    }
    return send;
  } catch (error) {
    logError("email", "Moderation notification error", {
      message: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

// ?notify=false opts out. Absent (the checkbox-checked default) sends.
export function notifyRequested(query: { notify?: string }): boolean {
  return query.notify !== "false";
}
