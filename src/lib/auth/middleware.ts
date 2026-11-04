import { Context, MiddlewareHandler } from "hono";
import { getPlatform } from "../middleware";
import { AuthPrincipal, TokenVerifier } from "./interfaces";
import { bearerAssertionVerifier } from "./bearer-assertion";

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthPrincipal;
  }
}

// Ordered list of verifiers tried for an incoming bearer token.
// Domain-specific verifiers (e.g. extensions v2's machine-token verifier
// for CI publishers) are registered by the service that owns them, by
// passing an explicit list — this default stays the human-assertion path
// so account routes never accept machine credentials.
const verifiers: TokenVerifier[] = [bearerAssertionVerifier];

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
