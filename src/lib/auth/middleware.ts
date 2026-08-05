import { Context, MiddlewareHandler } from "hono";
import { getPlatform } from "../middleware";
import { AuthPrincipal, TokenVerifier } from "./interfaces";
import { bearerAssertionVerifier } from "./bearer-assertion";

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthPrincipal;
  }
}

// Ordered list of verifiers tried for an incoming bearer token. Adding the
// future long-lived API-key verifier means appending here — route handlers
// and requireAuth() itself don't change.
const verifiers: TokenVerifier[] = [bearerAssertionVerifier];

export function requireAuth(): MiddlewareHandler {
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
    for (const verifier of verifiers) {
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
