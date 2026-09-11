import { loadEmailIdentity, resolveEmailProvider } from "./config";
import { loadMxrouteConfig, MxrouteSender } from "./mxroute";
import { loadResendConfig, ResendSender } from "./resend";
import type { EmailSender, EmailSendResult, EnvReader, FetchFn } from "./types";

// Local dev and tests have no mail credentials: report every send as skipped
// rather than throwing, so moderation writes never depend on email config.
// The reason distinguishes "never enabled" from "selected but incomplete" in
// notify.ts's failure log.
export class DisabledSender implements EmailSender {
  constructor(private reason = "email notifications are disabled") {}

  async send(): Promise<EmailSendResult> {
    return { ok: false, error: this.reason };
  }
}

// Pure composition over per-provider loaders: a selected provider whose
// credentials are incomplete degrades to disabled rather than failing the
// moderation write that triggered it.
export function createEmailSender(
  env: EnvReader,
  fetchFn?: FetchFn
): EmailSender {
  const identity = loadEmailIdentity(env);
  switch (resolveEmailProvider(env)) {
    case "mxroute": {
      const config = loadMxrouteConfig(env, identity);
      return config
        ? new MxrouteSender(config, fetchFn)
        : new DisabledSender("mxroute credentials are not configured");
    }
    case "resend": {
      const config = loadResendConfig(env, identity);
      return config
        ? new ResendSender(config, fetchFn)
        : new DisabledSender("resend api key is not configured");
    }
    default:
      return new DisabledSender();
  }
}
