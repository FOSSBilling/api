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
import { sha256Hex } from "../../../lib/hash";
import { UsersDatabase } from "./db/users";
import { PublisherClientsDatabase } from "./db/publisher-clients";

// Machine principal resolved against the m2m_publisher_clients mapping by the
// publisher middleware. Absent for human callers; handlers read it to pick
// the publisher-specific write path.
export interface PublisherContext {
  clientId: string;
  developerId: string;
  ownershipEpoch: number;
  canPublish: boolean;
}

declare module "hono" {
  interface ContextVariableMap {
    publisher?: PublisherContext;
  }
}

// Machine principals authenticate through the same bearer chain, so every
// route that is not one of the three publisher writes must reject them
// explicitly — their synthetic user would otherwise pass the account checks
// below and act as a (strange) user.
function isM2m(auth: AuthPrincipal): boolean {
  return auth.scope === "m2m";
}

const m2mForbiddenResponse = {
  error: {
    message: "Machine tokens are not accepted on this route",
    code: "FORBIDDEN"
  }
} as const;

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
  const auth = (c.get("auth") as AuthPrincipal | undefined) ?? null;
  // Machine principals never carry role-aware read access; their reads stay
  // anonymous, and a caller presenting one to a user-only route is answered
  // by the publisher middlewares, not here.
  return auth?.scope === "m2m" ? null : auth;
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
    const auth = getAuth(c);
    if (isM2m(auth)) return c.json(m2mForbiddenResponse, 403);
    const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const result = await users.isActive(auth.userId);
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
      const hex = await sha256Hex(rawBody);
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
    const auth = getAuth(c);
    if (isM2m(auth)) return c.json(m2mForbiddenResponse, 403);
    const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const result = await users.moderatorAccess(auth.userId);
    if (result.error) return c.json({ error: result.error }, 500);
    if (!result.data?.active) return c.json(inactiveAccountResponse, 403);
    if (!result.data.moderator)
      return c.json(
        { error: { message: "Moderator access required", code: "FORBIDDEN" } },
        403
      );
  });
}

// User-only routes behind bare requireAuth() (GET/DELETE /users/me): a
// machine principal has an account projection but must not read or delete it.
export function requireUser(): MiddlewareHandler {
  return withAuthenticatedCheck(async (c) => {
    if (isM2m(getAuth(c))) return c.json(m2mForbiddenResponse, 403);
  });
}

export function getPublisher(c: Context): PublisherContext | null {
  return c.get("publisher") ?? null;
}

const insufficientScopeResponse = (required: string) =>
  ({
    error: {
      message: `This operation requires the ${required} scope`,
      code: "FORBIDDEN"
    }
  }) as const;

// Resolves the m2m mapping and checks the token's scope for a publisher
// write. Human callers never reach this - their middleware branch is the
// account/ownership check, and they carry no OAuth scopes on this API.
// `requireCanPublish` only fast-fails here: the write statements re-assert
// registration, publish flag, and epoch binding atomically.
async function resolvePublisher(
  c: Context,
  m2m: AuthPrincipal & { scope: "m2m" },
  requiredScope: string,
  requireCanPublish = false
): Promise<Response | undefined> {
  const publishers = new PublisherClientsDatabase(
    getExtensionsDb(c.env.DB_EXTENSIONS)
  );
  const ref = await publishers.getActiveRef(m2m.clientId);
  if (ref.error) return c.json({ error: ref.error }, 500);
  if (!ref.data) {
    return c.json(
      {
        error: {
          message: "Publisher client is not registered for this developer",
          code: "FORBIDDEN"
        }
      },
      403
    );
  }
  if (ref.data.stale) {
    return c.json(
      {
        error: {
          message:
            "Publisher binding is stale after an ownership change; ask a moderator to re-register it",
          code: "FORBIDDEN"
        }
      },
      403
    );
  }
  if (!m2m.scopes.includes(requiredScope)) {
    return c.json(insufficientScopeResponse(requiredScope), 403);
  }
  if (requireCanPublish && !ref.data.canPublish) {
    return c.json(
      {
        error: {
          message: "Publisher client cannot publish for this developer",
          code: "FORBIDDEN"
        }
      },
      403
    );
  }
  c.set("publisher", { clientId: m2m.clientId, ...ref.data });
}

// POST /extensions and PUT /extensions/{id} accept either an active human
// account or a registered publisher client holding extensions:push.
export function requireContentWrite(): MiddlewareHandler {
  return withAuthenticatedCheck(async (c) => {
    const auth = getAuth(c);
    if (auth.scope === "m2m") {
      return resolvePublisher(c, auth, "extensions:push");
    }
    const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const result = await users.isActive(auth.userId);
    if (result.error) return c.json({ error: result.error }, 500);
    if (!result.data) return c.json(inactiveAccountResponse, 403);
  });
}

// The approve route accepts a moderator or, as the first-party carve-out, a
// publisher client holding extensions:publish and can_publish on the mapping.
export function requireApproveAccess(): MiddlewareHandler {
  return withAuthenticatedCheck(async (c) => {
    const auth = getAuth(c);
    if (auth.scope === "m2m") {
      return resolvePublisher(c, auth, "extensions:publish", true);
    }
    const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const result = await users.moderatorAccess(auth.userId);
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
      let body = new Uint8Array(0);
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RAW_BODY_BYTES) {
            await reader.cancel().catch(() => {});
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
          if (size > body.byteLength) {
            const grown = new Uint8Array(
              Math.min(
                MAX_RAW_BODY_BYTES,
                Math.max(size, body.byteLength * 2, 1024)
              )
            );
            grown.set(body);
            body = grown;
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
    const auth = identity === "ip" ? null : getAuth(c);
    // Machine clients pace under their own client key, not the synthetic
    // user's, so one misbehaving publisher cannot exhaust a human's budget.
    const subject =
      identity === "ip"
        ? (c.req.header("CF-Connecting-IP") ?? "unknown")
        : auth?.scope === "m2m"
          ? auth.clientId
          : (auth?.userId ?? "unknown");
    const bucket =
      identity === "ip" ? "ip" : auth?.scope === "m2m" ? "client" : "account";
    try {
      const { success } = await c.env.EXTENSION_WRITE_RATE_LIMITER.limit({
        key: `${bucket}:${subject}`
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
