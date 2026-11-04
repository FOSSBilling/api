import { PlatformContext } from "../context";

export type MachinePrincipal = {
  userId: string;
  scope: "machine";
  clientId: string;
  scopes: string[];
  canPublish: boolean;
};

export type AuthPrincipal =
  | { userId: string; scope: "assertion" | "api_key" }
  | { userId: string; scope: "identity_sync"; bodySha256: string }
  | MachinePrincipal;

export interface TokenVerifier {
  verify(
    token: string,
    platform: PlatformContext
  ): Promise<AuthPrincipal | null>;
}
