import { logInfo, logError } from "../../../lib/logger";
import { MAX_RAW_BODY_BYTES } from "./resource-limits";
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
      let rawBody: ArrayBuffer;
      try {
        rawBody = await c.req.arrayBuffer();
      } catch {
        return c.json(
          {
            error: {
              message: "Unable to read request body",
              code: "BAD_REQUEST"
            }
          },
          400
        );
      }
      const digest = await crypto.subtle.digest("SHA-256", rawBody);
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

// Registered before JSON validators on the three content-write routes.
export function boundContentRequest(): MiddlewareHandler {
  return async (c, next) => {
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      const body = new Uint8Array(MAX_RAW_BODY_BYTES);
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RAW_BODY_BYTES) {
            await reader.cancel();
            logInfo("extensions-v2", "Resource admission rejected", {
              reason: "raw_body_size"
            });
            return c.json(
              {
                error: {
                  message: "Request body must not exceed 512 KiB",
                  code: "BODY_TOO_LARGE"
                }
              },
              413
            );
          }
          body.set(value, size - value.byteLength);
        }
      } catch {
        return c.json(
          {
            error: {
              message: "Unable to read request body",
              code: "BAD_REQUEST"
            }
          },
          400
        );
      } finally {
        reader.releaseLock();
      }
      c.req.raw = new Request(c.req.raw, { body: body.subarray(0, size) });
    }
    await next();
  };
}

function paceContentAttempts(identity: "ip" | "account"): MiddlewareHandler {
  return async (c, next) => {
    const subject =
      identity === "ip"
        ? (c.req.header("CF-Connecting-IP") ?? "unknown")
        : getAuth(c).userId;
    try {
      const { success } = await c.env.EXTENSION_WRITE_RATE_LIMITER.limit({
        key: `${identity}:${subject}`
      });
      if (!success) {
        c.header("Retry-After", "60");
        logInfo("extensions-v2", "Resource admission rejected", {
          reason: identity === "ip" ? "attempt_rate" : "account_attempt_rate"
        });
        return c.json(
          {
            error: {
              message: "Too many extension write attempts",
              code: "RATE_LIMITED"
            }
          },
          429
        );
      }
    } catch {
      logError("extensions-v2", "Attempt limiter unavailable", { identity });
      c.header("Retry-After", "60");
      return c.json(
        {
          error: {
            message: "Write admission unavailable",
            code: "ADMISSION_UNAVAILABLE"
          }
        },
        503
      );
    }
    await next();
  };
}

export const paceContentIp = () => paceContentAttempts("ip");
export const paceContentAccount = () => paceContentAttempts("account");

// Count streamed response bytes without buffering or copying response bodies.
export function observeResourceResponses(): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    if (!c.res.body) return;
    const status = c.res.status;
    let bytes = 0;
    const body = c.res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush() {
          logInfo("extensions-v2", "Revision response", {
            status,
            response_bytes: bytes,
            duration_ms: Math.round(performance.now() - started)
          });
        }
      })
    );
    c.res = new Response(body, c.res);
  };
}
