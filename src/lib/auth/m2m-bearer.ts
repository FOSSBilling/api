import { verifyBearerToken } from "better-auth/oauth2";
import type { AuthPrincipal, TokenVerifier } from "./interfaces";

// Machine-to-machine bearer tokens minted by the central auth service's
// client_credentials grant (FOSSBilling/auth). Tokens carrying a `resource`
// bound to this API are RFC 9068 access-token JWTs (`typ: at+jwt`) signed
// EdDSA; tokens without a `resource` are opaque and useless here, so they
// fail verification and the caller gets 401.
//
// Verification is delegated to Better Auth's resource-server API, which
// fetches and caches the issuer's JWKS (5-minute TTL, single-flight fetch,
// refetch cooldown on unknown kids) and checks signature, issuer, audience,
// and expiry. Scope enforcement stays with the route middleware so an
// insufficient-scope failure can answer 403 while a bad token answers 401.

const M2M_USER_PREFIX = "m2m:";

function decodeJwtHeader(token: string): { typ?: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

export const m2mBearerVerifier: TokenVerifier = {
  async verify(token, platform): Promise<AuthPrincipal | null> {
    const issuer = platform.getEnv("M2M_ISSUER");
    const jwksUrl = platform.getEnv("M2M_JWKS_URL");
    const audience = platform.getEnv("M2M_AUDIENCE");
    if (!issuer || !jwksUrl || !audience) return null;

    // Better Auth stamps RFC 9068 access tokens with typ "at+jwt"; the
    // site's user assertions are HS256 JWTs that would otherwise be handed
    // to the EdDSA path every request. jose does not enforce typ itself.
    const header = decodeJwtHeader(token);
    if (!header || header.typ !== "at+jwt") return null;

    let payload: Record<string, unknown>;
    try {
      payload = (await verifyBearerToken(token, {
        verifyOptions: { issuer, audience },
        jwksUrl
      })) as Record<string, unknown>;
    } catch {
      return null;
    }

    const clientId = payload.client_id;
    const scope = payload.scope;
    if (typeof clientId !== "string" || typeof scope !== "string") {
      return null;
    }
    const scopes = scope.split(" ").filter(Boolean);
    if (scopes.length === 0) return null;
    // `sub` mirrors the client for client_credentials grants; require the
    // two to agree so neither can be read alone as the machine identity.
    if (payload.sub !== clientId) return null;

    return {
      scope: "m2m",
      clientId,
      scopes,
      userId: `${M2M_USER_PREFIX}${clientId}`
    };
  }
};
