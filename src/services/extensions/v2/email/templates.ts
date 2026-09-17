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
  // Numeric entities are pure ASCII, so they survive MXroute declaring the
  // HTML body iso-8859-1 while receiving UTF-8 (see subjectLabel). Resend
  // renders them identically, and the plain-text part below keeps raw
  // unicode for clients that prefer it.
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        out += code > 127 ? `&#${code};` : ch;
      }
    }
  }
  return out;
}

// A name pasted with its own quotes would double up against the wrapping
// quotes the labels below add (after folding, both render as straight
// quotes). Strip surrounding quote-like characters and whitespace first.
function stripSurroundingQuotes(value: string): string {
  return value.replace(/^['"“”‘’\s]+|['"“”‘’\s]+$/g, "");
}

// Names come from user input with no newline restriction, and labels feed
// the email subject — strip line breaks and tabs so a name can never split
// an SMTP header.
function subjectLabel(value: string): string {
  return (
    value
      .replace(/[\r\n\t]+/g, " ")
      // MXroute's SMTP API declares subjects iso-8859-1 while receiving
      // UTF-8, so any non-ASCII byte renders as mojibake (curly quotes show
      // as "â€œ"). Fold to ASCII: strip diacritics, map common punctuation,
      // and replace anything left with "?" rather than corrupt it.
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[–—]/g, "-")
      .replace(/…/g, "...")
      .replace(/\u00a0/g, " ")
      .replace(/[^\u0020-\u007E]/g, "?")
  );
}

// Bare URLs are auto-linked by most clients but not all — wrap them in
// explicit anchors so the dashboard link is always clickable. Runs on the
// escaped text: quotes are already entities, so a URL cannot contain a raw
// `"` or `<` that would break out of the href.
function linkify(escaped: string): string {
  return escaped.replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
}

function layout(
  title: string,
  paragraphs: string[]
): { html: string; text: string } {
  // A complete document rather than a fragment: MXroute flags fragment-only
  // bodies (HTML_MIME_NO_HTML_TAG) and some clients render fragments
  // inconsistently.
  const html = `<p>${paragraphs.map((p) => linkify(escapeHtml(p))).join("</p><p>")}</p>`;
  return {
    html: `<html><body><h2>${escapeHtml(title)}</h2>${html}</body></html>`,
    text: `${title}\n\n${paragraphs.join("\n\n")}`
  };
}

export function buildModerationEmail(
  input: ModerationEmailInput
): EmailMessage {
  const extLabel = subjectLabel(
    input.extensionName && input.extensionId
      ? `“${stripSurroundingQuotes(input.extensionName)}” (${input.extensionId})`
      : (input.extensionId ?? input.extensionName ?? "your extension")
  );
  const devLabel = subjectLabel(
    input.developerName && input.developerId
      ? `“${stripSurroundingQuotes(input.developerName)}” (${input.developerId})`
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
        `View it here: ${DASHBOARD_URL}`
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
        `View your claims here: ${DASHBOARD_URL}`
      ];
      break;
  }

  const { html, text } = layout(title, paragraphs);
  return { to: input.to, subject: `[FOSSBilling] ${subject}`, html, text };
}
