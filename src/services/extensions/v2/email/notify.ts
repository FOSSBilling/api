import type { ExtensionsDb } from "../../../../lib/db";
import { logError } from "../../../../lib/logger";
import { createEmailSender } from "./factory";
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
export async function sendModerationNotification(
  env: EnvReader,
  db: ExtensionsDb,
  input: ModerationNotifyInput
): Promise<boolean> {
  try {
    let to: string | null;
    let extensionName: string | undefined;
    let developerName: string | undefined;
    let developerId = input.developerId;

    if (input.kind === "claim-approved" || input.kind === "claim-rejected") {
      if (!input.claimantId) return false;
      to = await resolveClaimantEmail(db, input.claimantId);
      if (!to) {
        logError("email", "No address for claim notification", {
          developerId: input.developerId
        });
        return false;
      }
      if (input.developerId) {
        developerName = (
          await resolveDeveloperProfileEmail(db, input.developerId)
        )?.developerName;
      }
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
}

// ?notify=false opts out. Absent (the checkbox-checked default) sends.
export function notifyRequested(query: { notify?: string }): boolean {
  return query.notify !== "false";
}
