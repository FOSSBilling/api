import { type Context, type MiddlewareHandler } from "hono";
import {
  bearerAssertionVerifier,
  identitySyncAssertionVerifier
} from "../../../lib/auth/bearer-assertion";
import { getAuth, requireAuth } from "../../../lib/auth";
import type { AuthPrincipal } from "../../../lib/auth";
import { getExtensionsDb } from "../../../lib/db";
import { UsersDatabase } from "./db/users";

export const requireAuthAllowInactive = requireAuth;

// Optional bearer auth for merged public+authenticated reads: no
// Authorization header continues anonymously; a present header is verified
// normally (invalid tokens still 401 rather than silently downgrading to
// anonymous, so callers cannot mistake a broken token for a public read).
export function optionalAuth(): MiddlewareHandler {
  const authenticate = requireAuth();
  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header?.trim()) return next();
    return authenticate(c, next);
  };
}

// Returns the principal when optionalAuth() authenticated the caller, or null
// for anonymous reads - read directly rather than through getAuth()'s throw.
export function getOptionalAuth(c: Context): AuthPrincipal | null {
  return (c.get("auth") as AuthPrincipal | undefined) ?? null;
}

type AuthenticatedCheck = (c: Context) => Promise<Response | undefined>;

function withAuthenticatedCheck(
  check: AuthenticatedCheck,
  authenticate = requireAuth()
): MiddlewareHandler {
  return async (c, next) => {
    let response: Response | undefined;
    const authenticationResult = await authenticate(c, async () => {
      const checkResponse = await check(c);
      if (checkResponse) {
        response = checkResponse;
      } else {
        await next();
      }
    });
    return response ?? authenticationResult;
  };
}

const inactiveAccountResponse = {
  error: {
    message: "Active account required",
    code: "ACCOUNT_INACTIVE"
  }
} as const;

export function requireActiveAuth(): MiddlewareHandler {
  return withAuthenticatedCheck(async (c) => {
    const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const result = await users.isActive(getAuth(c).userId);
    if (result.error) return c.json({ error: result.error }, 500);
    if (!result.data) return c.json(inactiveAccountResponse, 403);
  });
}

export function requireIdentitySync(): MiddlewareHandler {
  return withAuthenticatedCheck(
    async (c) => {
      const auth = getAuth(c);
      if (auth.scope !== "identity_sync") {
        return c.json(
          {
            error: {
              message: "Identity synchronization requires a trusted assertion",
              code: "FORBIDDEN"
            }
          },
          403
        );
      }
      // Hash the exact bytes before JSON parsing. Hono caches this buffer so
      // validation and persistence consume the same authenticated body.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await c.req.arrayBuffer()
      );
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      if (hex !== auth.bodySha256) {
        return c.json(
          {
            error: {
              message: "Identity payload does not match assertion",
              code: "FORBIDDEN"
            }
          },
          403
        );
      }
    },
    requireAuth([identitySyncAssertionVerifier, bearerAssertionVerifier])
  );
}

// Moderator routes list this alone, not behind requireActiveAuth(): it
// authenticates through the same combinator and answers both the active and
// the moderator question from one row. The two 403s are distinct on purpose -
// a deactivated moderator gets ACCOUNT_INACTIVE, not FORBIDDEN.
export function requireModerator(): MiddlewareHandler {
  return withAuthenticatedCheck(async (c) => {
    const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const result = await users.moderatorAccess(getAuth(c).userId);
    if (result.error) return c.json({ error: result.error }, 500);
    if (!result.data?.active) return c.json(inactiveAccountResponse, 403);
    if (!result.data.moderator)
      return c.json(
        { error: { message: "Moderator access required", code: "FORBIDDEN" } },
        403
      );
  });
}
