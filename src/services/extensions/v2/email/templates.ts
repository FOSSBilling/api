import type { EmailMessage } from "./types";

export type ModerationEmailKind =
  | "extension-delisted"
  | "revision-approved"
  | "revision-rejected"
  | "developer-approved"
  | "claim-approved"
  | "claim-rejected";

export interface ModerationEmailInput {
  kind: ModerationEmailKind;
  to: string;
  extensionId?: string;
  extensionName?: string;
  developerId?: string;
  developerName?: string;
  reason?: string;
}

const DASHBOARD_URL = "https://extensions.fossbilling.org/account";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Names come from user input with no newline restriction, and labels feed
// the email subject — strip CR/LF so a name can never split an SMTP header.
function subjectLabel(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function layout(
  title: string,
  paragraphs: string[]
): { html: string; text: string } {
  const html = `<p>${paragraphs.map(escapeHtml).join("</p><p>")}</p>`;
  return {
    html: `<h2>${escapeHtml(title)}</h2>${html}`,
    text: `${title}\n\n${paragraphs.join("\n\n")}`
  };
}

export function buildModerationEmail(
  input: ModerationEmailInput
): EmailMessage {
  const extLabel = subjectLabel(
    input.extensionName && input.extensionId
      ? `“${input.extensionName}” (${input.extensionId})`
      : (input.extensionId ?? input.extensionName ?? "your extension")
  );
  const devLabel = subjectLabel(
    input.developerName && input.developerId
      ? `“${input.developerName}” (${input.developerId})`
      : (input.developerId ?? input.developerName ?? "your developer profile")
  );

  let subject: string;
  let title: string;
  let paragraphs: string[];

  switch (input.kind) {
    case "extension-delisted":
      subject = `${extLabel} removed from the FOSSBilling directory`;
      title = "Your extension was removed from the directory";
      paragraphs = [
        `${extLabel} has been removed from the public FOSSBilling extension directory by a moderator. Its content and history are kept, and you can still see it in your dashboard.`,
        input.reason ? `Reason given: ${input.reason}` : "No reason was given.",
        `View it here: ${DASHBOARD_URL}`,
        "If you believe this was a mistake, reply to this email."
      ];
      break;
    case "revision-approved":
      subject = `${extLabel} update approved`;
      title = "Your extension update was approved";
      paragraphs = [
        `Your update to ${extLabel} has been approved by a moderator and is now live in the directory.`,
        ...(input.reason ? [`Moderator note: ${input.reason}`] : []),
        `View it here: ${DASHBOARD_URL}`
      ];
      break;
    case "revision-rejected":
      subject = `${extLabel} update needs changes`;
      title = "Your extension update was not approved";
      paragraphs = [
        `Your update to ${extLabel} was not approved. The published version is unchanged.`,
        input.reason ? `Reason given: ${input.reason}` : "No reason was given.",
        `Revise and resubmit here: ${DASHBOARD_URL}`
      ];
      break;
    case "developer-approved":
      subject = `${devLabel} approved`;
      title = "Your developer profile was approved";
      paragraphs = [
        `${devLabel} has been reviewed and approved. It now shows an approval badge in the directory.`,
        `View it here: ${DASHBOARD_URL}/developer`
      ];
      break;
    case "claim-approved":
      subject = `${devLabel} claim approved`;
      title = "Your profile claim was approved";
      paragraphs = [
        `Your claim on ${devLabel} has been approved. You now own this developer profile.`,
        `Manage it here: ${DASHBOARD_URL}/developer`
      ];
      break;
    case "claim-rejected":
      subject = `${devLabel} claim not approved`;
      title = "Your profile claim was not approved";
      paragraphs = [
        `Your claim on ${devLabel} was not approved.`,
        input.reason ? `Reason given: ${input.reason}` : "No reason was given.",
        "If you believe this was a mistake, reply to this email."
      ];
      break;
  }

  const { html, text } = layout(title, paragraphs);
  return { to: input.to, subject: `[FOSSBilling] ${subject}`, html, text };
}
