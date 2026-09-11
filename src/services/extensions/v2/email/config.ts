export type EmailProvider = "mxroute" | "resend" | "disabled";

export interface EmailConfig {
  provider: EmailProvider;
  from: string;
  replyTo?: string;
  mxrouteServer?: string;
  mxrouteUsername?: string;
  mxroutePassword?: string;
  resendApiKey?: string;
}

function readString(
  env: Record<string, unknown>,
  key: string
): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Secrets (wrangler secret put) are absent in local dev/test, so every
// credential is optional here and validated where it is used: an incomplete
// mxroute/resend config degrades to a logged failure rather than a 500.
export function getEmailConfig(env: Record<string, unknown>): EmailConfig {
  const providerRaw = readString(env, "EMAIL_PROVIDER")?.toLowerCase();
  const provider: EmailProvider =
    providerRaw === "mxroute" ||
    providerRaw === "resend" ||
    providerRaw === "disabled"
      ? providerRaw
      : "disabled";

  return {
    provider,
    from: readString(env, "EMAIL_FROM") ?? "extensions@fossbilling.org",
    replyTo: readString(env, "EMAIL_REPLY_TO"),
    mxrouteServer: readString(env, "MXROUTE_SERVER"),
    mxrouteUsername: readString(env, "MXROUTE_USERNAME"),
    mxroutePassword: readString(env, "MXROUTE_PASSWORD"),
    resendApiKey: readString(env, "RESEND_API_KEY")
  };
}
