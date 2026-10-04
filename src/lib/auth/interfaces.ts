import { PlatformContext } from "../context";

export type AuthPrincipal =
  | { userId: string; scope: "assertion" | "api_key" }
  | { userId: string; scope: "identity_sync"; bodySha256: string };

export interface TokenVerifier {
  verify(
    token: string,
    platform: PlatformContext
  ): Promise<AuthPrincipal | null>;
}
