import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  post,
  sampleCreate
} from "./harness";
import {
  insertUser,
  insertDeveloper,
  insertExtension,
  insertDeveloperClaim,
  getExtension,
  bumpDeveloperOwnership
} from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

const MXROUTE_ENV = {
  EMAIL_PROVIDER: "mxroute",
  EMAIL_FROM: "extensions@fossbilling.org",
  EMAIL_REPLY_TO: "noreply@fossbilling.org",
  MXROUTE_SERVER: "tuesday.mxrouting.net",
  MXROUTE_USERNAME: "extensions@fossbilling.org",
  MXROUTE_PASSWORD: "secret"
};

type EmailEnvKey = keyof typeof MXROUTE_ENV;

function setEmailEnv(): void {
  for (const [key, value] of Object.entries(MXROUTE_ENV)) {
    (env as unknown as Record<string, unknown>)[key] = value;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(MXROUTE_ENV) as EmailEnvKey[]) {
    delete (env as unknown as Record<string, unknown>)[key];
  }
});

function stubSmtpApi(payload: unknown = { success: true, message: "sent" }) {
  const calls: Array<{ url: unknown; init: RequestInit }> = [];
  vi.stubGlobal("fetch", (async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init: init as RequestInit });
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch);
  return calls;
}

async function seedLiveExtension(): Promise<void> {
  await insertDeveloper(db, {
    id: "new-developer",
    type: "user",
    name: "New Developer",
    url: null,
    owner_user_id: "user-1",
    contact_email: "author@example.com"
  });
  await insertExtension(db, { id: "live-ext", developer_id: "new-developer" });
}

async function seedPendingClaim(): Promise<void> {
  await insertUser(db, { id: "mod-1", is_moderator: 1 });
  await insertUser(db, { id: "claimant-1", email: "claimant@example.com" });
  await insertDeveloper(db, {
    id: "legacy-dev",
    type: "user",
    name: "Legacy",
    url: null,
    owner_user_id: null
  });
  await insertDeveloperClaim(db, {
    id: "claim-1",
    developer_id: "legacy-dev",
    claimant_id: "claimant-1"
  });
}

describe("moderation notification emails", () => {
  it("emails the developer contact address on delist", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await seedLiveExtension();
    setEmailEnv();
    const calls = stubSmtpApi();

    const res = await post(
      "/extensions/v2/extensions/live-ext/delist",
      await authHeaders("mod-1"),
      { reason: "Upstream source removed" }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      result: { id: "live-ext", status: "delisted", notified: true }
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0].url)).toBe("https://smtpapi.mxroute.com/");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      to: "author@example.com",
      from: "extensions@fossbilling.org",
      reply_to: "noreply@fossbilling.org"
    });
    expect(body.subject).toContain("live-ext");
    expect(body.body).toContain("Upstream source removed");
  });

  it("skips the email on ?notify=false without calling the provider", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await seedLiveExtension();
    setEmailEnv();
    const calls = stubSmtpApi();

    const res = await post(
      "/extensions/v2/extensions/live-ext/delist?notify=false",
      await authHeaders("mod-1"),
      { reason: "Upstream source removed" }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      result: { id: "live-ext", status: "delisted", notified: false }
    });
    expect(calls).toHaveLength(0);
  });

  it("falls back to the owner account email when no contact email exists", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await insertUser(db, { id: "user-1", email: "owner@example.com" });
    await insertDeveloper(db, {
      id: "new-developer",
      type: "user",
      name: "New Developer",
      url: null,
      owner_user_id: "user-1"
    });
    await insertExtension(db, {
      id: "live-ext",
      developer_id: "new-developer"
    });
    setEmailEnv();
    const calls = stubSmtpApi();

    const res = await post(
      "/extensions/v2/extensions/live-ext/delist",
      await authHeaders("mod-1"),
      { reason: "Upstream source removed" }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      result: { notified: true }
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toBe("owner@example.com");
  });

  it("still delists when the provider fails", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await seedLiveExtension();
    setEmailEnv();
    stubSmtpApi({ success: false, message: "Invalid server specified." });

    const res = await post(
      "/extensions/v2/extensions/live-ext/delist",
      await authHeaders("mod-1"),
      { reason: "Upstream source removed" }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      result: { id: "live-ext", status: "delisted", notified: false }
    });
    expect((await getExtension(db, "live-ext"))?.delist_reason).toBe(
      "Upstream source removed"
    );
  });

  // The revision submitter and the owner start as the same account, so the
  // ownership is transferred before review: the email must follow the
  // current owner, not the original submitter.
  it("notifies the current owner on reject, not the original submitter", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await insertUser(db, { id: "user-1", email: "original@example.com" });
    await insertDeveloper(db, {
      id: "new-developer",
      type: "user",
      name: "New Developer",
      url: null,
      owner_user_id: "user-1"
    });
    const created = await post(
      "/extensions/v2/extensions",
      await authHeaders("user-1"),
      sampleCreate({ extensionId: "reject-me" })
    );
    expect(created.status).toBe(201);
    const { result } = (await created.json()) as {
      result: { id: string; revision_id: string };
    };
    await bumpDeveloperOwnership(db, "new-developer", "user-2");
    await insertUser(db, { id: "user-2", email: "current@example.com" });
    setEmailEnv();
    const calls = stubSmtpApi();

    const res = await post(
      `/extensions/v2/extensions/${result.id}/revisions/${result.revision_id}/reject`,
      await authHeaders("mod-1"),
      { review_note: "Needs a valid license URL" }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      result: { status: "rejected", notified: true }
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toBe("current@example.com");
    expect(body.body).toContain("Needs a valid license URL");
  });

  it("notifies the claimant on claim approval", async () => {
    await seedPendingClaim();
    setEmailEnv();
    const calls = stubSmtpApi();

    const res = await post(
      "/extensions/v2/developers/claims/claim-1/approve",
      await authHeaders("mod-1")
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      result: { notified: true }
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toBe("claimant@example.com");
  });

  it("notifies the claimant with the reason on claim rejection", async () => {
    await seedPendingClaim();
    setEmailEnv();
    const calls = stubSmtpApi();

    const res = await post(
      "/extensions/v2/developers/claims/claim-1/reject",
      await authHeaders("mod-1"),
      { review_note: "Could not verify ownership" }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      result: { notified: true }
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toBe("claimant@example.com");
    expect(body.body).toContain("Could not verify ownership");
  });

  it("reports notified:false when no address exists anywhere", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await insertDeveloper(db, {
      id: "new-developer",
      type: "user",
      name: "New Developer",
      url: null,
      owner_user_id: null
    });
    await insertExtension(db, {
      id: "live-ext",
      developer_id: "new-developer"
    });
    setEmailEnv();
    const calls = stubSmtpApi();

    const res = await post(
      "/extensions/v2/extensions/live-ext/delist",
      await authHeaders("mod-1"),
      { reason: "Upstream source removed" }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      result: { notified: false }
    });
    expect(calls).toHaveLength(0);
  });

  // Raw fixture insert bypasses DeveloperInputSchema's email check the way a
  // legacy row predating it would: the value contains "@" but is not an
  // address, so resolution must fall through to the account email.
  it("ignores a malformed contact email and falls back to the account email", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await insertUser(db, { id: "user-1", email: "owner@example.com" });
    await insertDeveloper(db, {
      id: "new-developer",
      type: "user",
      name: "New Developer",
      url: null,
      owner_user_id: "user-1",
      contact_email: "The Owner <owner@example.com>"
    });
    await insertExtension(db, {
      id: "live-ext",
      developer_id: "new-developer"
    });
    setEmailEnv();
    const calls = stubSmtpApi();

    const res = await post(
      "/extensions/v2/extensions/live-ext/delist",
      await authHeaders("mod-1"),
      { reason: "Upstream source removed" }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      result: { notified: true }
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toBe("owner@example.com");
  });

  it("drops a whitespace-only moderator note from the approval email", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await insertUser(db, { id: "user-1", email: "owner@example.com" });
    await insertDeveloper(db, {
      id: "new-developer",
      type: "user",
      name: "New Developer",
      url: null,
      owner_user_id: "user-1"
    });
    const created = await post(
      "/extensions/v2/extensions",
      await authHeaders("user-1"),
      sampleCreate({ extensionId: "approve-me" })
    );
    expect(created.status).toBe(201);
    const { result } = (await created.json()) as {
      result: { id: string; revision_id: string };
    };
    setEmailEnv();
    const calls = stubSmtpApi();

    const res = await post(
      `/extensions/v2/extensions/${result.id}/revisions/${result.revision_id}/approve`,
      await authHeaders("mod-1"),
      { review_note: "   " }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      result: { status: "approved", notified: true }
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.body).not.toContain("Moderator note");
  });
});
