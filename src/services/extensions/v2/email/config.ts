import type { EmailIdentity, EnvReader } from "./types";

export type EmailProviderName = "mxroute" | "resend";

// Validated selector only — provider credentials live with their own loader
// (loadMxrouteConfig/loadResendConfig), so adding a provider never touches
// this file beyond one enum member.
export function resolveEmailProvider(env: EnvReader): EmailProviderName | null {
  switch (env.getEnv("EMAIL_PROVIDER")?.toLowerCase()) {
    case "mxroute":
      return "mxroute";
    case "resend":
      return "resend";
    default:
      return null;
  }
}

export function loadEmailIdentity(env: EnvReader): EmailIdentity {
  // Blank counts as unset: an empty EMAIL_FROM would otherwise become an
  // invalid sender address instead of falling back to the default.
  const from = env.getEnv("EMAIL_FROM")?.trim();
  const replyTo = env.getEnv("EMAIL_REPLY_TO")?.trim();
  return {
    from: from ? from : "noreply@fossbilling.org",
    replyTo: replyTo ? replyTo : undefined
  };
}
