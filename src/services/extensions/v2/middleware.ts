import { type Context, type MiddlewareHandler } from "hono";
import { getAuth, requireAuth } from "../../../lib/auth";
import { getExtensionsDb } from "../../../lib/db";
import { UsersDatabase } from "./db/users";

export const requireAuthAllowInactive = requireAuth;

type AuthenticatedCheck = (c: Context) => Promise<Response | undefined>;

function withAuthenticatedCheck(check: AuthenticatedCheck): MiddlewareHandler {
  const authenticate = requireAuth();
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
  return withAuthenticatedCheck(async (c) => {
    if (getAuth(c).scope !== "assertion") {
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
  });
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
