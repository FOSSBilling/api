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

export function requireActiveAuth(): MiddlewareHandler {
  return withAuthenticatedCheck(async (c) => {
    const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const result = await users.isActive(getAuth(c).userId);
    if (result.error) return c.json({ error: result.error }, 500);
    if (!result.data) {
      return c.json(
        {
          error: {
            message: "Active account required",
            code: "ACCOUNT_INACTIVE"
          }
        },
        403
      );
    }
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

export function requireModerator(): MiddlewareHandler {
  return async (c, next) => {
    const auth = getAuth(c);
    const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const result = await users.isModerator(auth.userId);
    if (result.error) return c.json({ error: result.error }, 500);
    if (!result.data)
      return c.json(
        { error: { message: "Moderator access required", code: "FORBIDDEN" } },
        403
      );
    await next();
  };
}
