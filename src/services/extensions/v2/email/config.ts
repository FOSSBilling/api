import type { EmailIdentity, EnvReader } from "./types";

export type EmailProviderName = "mxroute" | "resend";

// Validated selector only — provider credentials live with their own loader
// (loadMxrouteConfig/loadResendConfig), so adding a provider never touches
// this file beyond one enum member.
// Scoped to this service: the worker hosts several services on one flat env
// namespace (see DB_EXTENSIONS), so an unscoped EMAIL_FROM would collide
// with the next service that sends mail.
export function resolveEmailProvider(env: EnvReader): EmailProviderName | null {
  switch (env.getEnv("EXTENSIONS_V2_EMAIL_PROVIDER")?.toLowerCase()) {
    case "mxroute":
      return "mxroute";
    case "resend":
      return "resend";
    default:
      return null;
  }
}

export function loadEmailIdentity(env: EnvReader): EmailIdentity {
  // Blank counts as unset: an empty EXTENSIONS_V2_EMAIL_FROM would otherwise
  // become an invalid sender address instead of falling back to the default.
  const from = env.getEnv("EXTENSIONS_V2_EMAIL_FROM")?.trim();
  const replyTo = env.getEnv("EXTENSIONS_V2_EMAIL_REPLY_TO")?.trim();
  return {
    from: from ? from : "noreply@fossbilling.org",
    replyTo: replyTo ? replyTo : undefined
  };
}
