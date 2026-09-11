import type { EmailConfig } from "./config";
import type {
  EmailMessage,
  EmailSender,
  EmailSendResult,
  FetchFn
} from "./types";

const SMTP_API_URL = "https://smtpapi.mxroute.com/";

// HTTP wrapper around MXroute's SMTP API: one JSON POST per recipient.
// Field names follow https://docs.mxroute.com/docs/api/smtp-api.html.
export class MxrouteSender implements EmailSender {
  constructor(
    private config: EmailConfig,
    private fetchFn: FetchFn = globalThis.fetch
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const { mxrouteServer, mxrouteUsername, mxroutePassword, from, replyTo } =
      this.config;
    if (!mxrouteServer || !mxrouteUsername || !mxroutePassword) {
      return { ok: false, error: "mxroute credentials are not configured" };
    }

    let response: Response;
    try {
      response = await this.fetchFn(SMTP_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server: mxrouteServer,
          username: mxrouteUsername,
          password: mxroutePassword,
          from,
          to: message.to,
          subject: message.subject,
          body: message.html,
          ...(replyTo ? { reply_to: replyTo } : {})
        }),
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "request failed"
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, error: `unexpected status ${response.status}` };
    }

    const body = payload as { success?: unknown; message?: unknown };
    if (response.ok && body.success === true) {
      return { ok: true };
    }
    const detail =
      typeof body.message === "string" && body.message.length > 0
        ? body.message
        : `unexpected status ${response.status}`;
    return { ok: false, error: detail };
  }
}
