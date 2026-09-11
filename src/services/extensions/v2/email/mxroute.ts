import type {
  EmailIdentity,
  EmailMessage,
  EmailSender,
  EmailSendResult,
  EnvReader,
  FetchFn
} from "./types";

const SMTP_API_URL = "https://smtpapi.mxroute.com/";

// Complete by construction: loadMxrouteConfig returns null unless every
// credential is present, so the sender never re-validates at send time.
export interface MxrouteConfig extends EmailIdentity {
  server: string;
  username: string;
  password: string;
}

export function loadMxrouteConfig(
  env: EnvReader,
  identity: EmailIdentity
): MxrouteConfig | null {
  const server = env.getEnv("MXROUTE_SERVER");
  const username = env.getEnv("MXROUTE_USERNAME");
  const password = env.getEnv("MXROUTE_PASSWORD");
  if (!server || !username || !password) return null;
  return { ...identity, server, username, password };
}

// HTTP wrapper around MXroute's SMTP API: one JSON POST per recipient.
// Field names follow https://docs.mxroute.com/docs/api/smtp-api.html.
export class MxrouteSender implements EmailSender {
  constructor(
    private config: MxrouteConfig,
    private fetchFn: FetchFn = globalThis.fetch
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const { server, username, password, from, replyTo } = this.config;

    let response: Response;
    try {
      response = await this.fetchFn(SMTP_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server,
          username,
          password,
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

    const body =
      payload !== null && typeof payload === "object"
        ? (payload as { success?: unknown; message?: unknown })
        : {};
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
