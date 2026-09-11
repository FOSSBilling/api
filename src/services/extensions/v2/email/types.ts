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
