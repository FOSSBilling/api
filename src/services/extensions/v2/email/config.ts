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
  return {
    from: env.getEnv("EMAIL_FROM") || "noreply@fossbilling.org",
    replyTo: env.getEnv("EMAIL_REPLY_TO")
  };
}
