export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type EmailSendResult = { ok: true } | { ok: false; error: string };

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export type FetchFn = typeof globalThis.fetch;

// Minimal env surface the email subsystem needs. Shaped to match
// PlatformContext, so routes pass getPlatform(c) directly — the same way
// GITHUB_TOKEN and the assertion secrets are read everywhere else.
export interface EnvReader {
  getEnv(key: string): string | undefined;
}

// Provider-neutral sender identity. Defaults live with loadEmailIdentity;
// providers only ever add their own credentials to this.
export interface EmailIdentity {
  from: string;
  replyTo?: string;
}
