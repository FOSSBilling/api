import { Context, MiddlewareHandler } from "hono";
import { getPlatform } from "../middleware";
import { AuthPrincipal, TokenVerifier } from "./interfaces";
import { bearerAssertionVerifier } from "./bearer-assertion";
import { m2mBearerVerifier } from "./m2m-bearer";

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthPrincipal;
  }
}

// Ordered list of verifiers tried for an incoming bearer token. The m2m
// verifier runs first: it filters on the RFC 9068 `typ: at+jwt` header, so
// machine tokens never fall through to the assertion verifier's failure
// warning, and user assertions (typ JWT) skip past it without a JWKS fetch.
// Adding the future long-lived API-key verifier means appending here — route
// handlers and requireAuth() itself don't change.
const verifiers: TokenVerifier[] = [m2mBearerVerifier, bearerAssertionVerifier];

export function requireAuth(
  tokenVerifiers: readonly TokenVerifier[] = verifiers
): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;

    if (!token) {
      return c.json(
        { error: { message: "Missing bearer token", code: "UNAUTHORIZED" } },
        401,
        { "WWW-Authenticate": "Bearer" }
      );
    }

    const platform = getPlatform(c);
    for (const verifier of tokenVerifiers) {
      const principal = await verifier.verify(token, platform);
      if (principal) {
        c.set("auth", principal);
        return next();
      }
    }

    return c.json(
      { error: { message: "Invalid or expired token", code: "UNAUTHORIZED" } },
      401,
      { "WWW-Authenticate": "Bearer" }
    );
  };
}

export function getAuth(c: Context): AuthPrincipal {
  const auth = c.get("auth");
  if (!auth) {
    throw new Error("Auth principal not found");
  }
  return auth;
}
