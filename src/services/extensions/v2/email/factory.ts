import { getEmailConfig } from "./config";
import { MxrouteSender } from "./mxroute";
import { ResendSender } from "./resend";
import type { EmailSender, EmailSendResult, FetchFn } from "./types";

// Local dev and tests have no mail credentials: report every send as skipped
// rather than throwing, so moderation writes never depend on email config.
export class DisabledSender implements EmailSender {
  async send(): Promise<EmailSendResult> {
    return { ok: false, error: "email provider is disabled" };
  }
}

export function createEmailSender(
  env: Record<string, unknown>,
  fetchFn?: FetchFn
): EmailSender {
  const config = getEmailConfig(env);
  switch (config.provider) {
    case "mxroute":
      return new MxrouteSender(config, fetchFn);
    case "resend":
      return new ResendSender(config, fetchFn);
    default:
      return new DisabledSender();
  }
}
