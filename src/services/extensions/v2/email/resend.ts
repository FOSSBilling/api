import type { EmailConfig } from "./config";
import type {
  EmailMessage,
  EmailSender,
  EmailSendResult,
  FetchFn
} from "./types";

const RESEND_API_URL = "https://api.resend.com/emails";

// Kept beside the MXroute sender so EMAIL_PROVIDER can switch without route
// changes. Activated by EMAIL_PROVIDER=resend with RESEND_API_KEY set.
export class ResendSender implements EmailSender {
  constructor(
    private config: EmailConfig,
    private fetchFn: FetchFn = globalThis.fetch
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.config.resendApiKey) {
      return { ok: false, error: "resend api key is not configured" };
    }

    let response: Response;
    try {
      response = await this.fetchFn(RESEND_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.resendApiKey}`
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(this.config.replyTo ? { reply_to: this.config.replyTo } : {})
        }),
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "request failed"
      };
    }

    if (response.ok) return { ok: true };

    let detail = `unexpected status ${response.status}`;
    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload.message === "string" && payload.message.length > 0) {
        detail = payload.message;
      }
    } catch {
      // Keep the status-based detail.
    }
    return { ok: false, error: detail };
  }
}
