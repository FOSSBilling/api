import { PlatformContext } from "../context";

export interface AuthPrincipal {
  userId: string;
  scope: "assertion" | "api_key";
}

export interface TokenVerifier {
  verify(
    token: string,
    platform: PlatformContext
  ): Promise<AuthPrincipal | null>;
}
