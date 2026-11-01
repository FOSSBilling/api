import type { PlatformContext } from "../context";

// The principal a TokenVerifier derives from a verified bearer token. The
// variants are mutually exclusive shapes; middleware branches on `scope`.
//
// `userId` on the m2m variant is the id of a synthetic `users` projection row
// (`m2m:<client_id>`, created when a moderator registers the client mapping).
// It satisfies the `users` foreign keys on revision rows and write budgets;
// it is not an account and never owns a developer profile. Machine principals
// are only valid on the publisher routes; every other middleware rejects them.
export type AuthPrincipal =
  | { userId: string; scope: "assertion" | "api_key" }
  | { userId: string; scope: "identity_sync"; bodySha256: string }
  | {
      scope: "m2m";
      clientId: string;
      scopes: string[];
      userId: string;
    };

export interface TokenVerifier {
  verify(
    token: string,
    platform: PlatformContext
  ): Promise<AuthPrincipal | null>;
}
