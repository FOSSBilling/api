import { describe, it, expect } from "vitest";
import {
  loadEmailIdentity,
  resolveEmailProvider
} from "../../../../src/services/extensions/v2/email/config";
import {
  loadMxrouteConfig,
  MxrouteSender
} from "../../../../src/services/extensions/v2/email/mxroute";
import {
  loadResendConfig,
  ResendSender
} from "../../../../src/services/extensions/v2/email/resend";
import {
  DisabledSender,
  createEmailSender
} from "../../../../src/services/extensions/v2/email/factory";
import { buildModerationEmail } from "../../../../src/services/extensions/v2/email/templates";
import { notifyRequested } from "../../../../src/services/extensions/v2/email/notify";
import type { EnvReader } from "../../../../src/services/extensions/v2/email/types";

function reader(vars: Record<string, string>): EnvReader {
  return { getEnv: (key) => vars[key] };
}

const IDENTITY = { from: "extensions@fossbilling.org" };

const MXROUTE_VARS = {
  EMAIL_PROVIDER: "mxroute",
  MXROUTE_SERVER: "tuesday.mxrouting.net",
  MXROUTE_USERNAME: "extensions@fossbilling.org",
  MXROUTE_PASSWORD: "secret"
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe("email config", () => {
  it("resolves no provider by default", () => {
    expect(resolveEmailProvider(reader({}))).toBeNull();
    expect(
      resolveEmailProvider(reader({ EMAIL_PROVIDER: "pigeon" }))
    ).toBeNull();
  });

  it("resolves the selected provider case-insensitively", () => {
    expect(resolveEmailProvider(reader({ EMAIL_PROVIDER: "MXRoute" }))).toBe(
      "mxroute"
    );
    expect(resolveEmailProvider(reader({ EMAIL_PROVIDER: "resend" }))).toBe(
      "resend"
    );
  });

  it("loads the sender identity with the directory from address", () => {
    expect(loadEmailIdentity(reader({}))).toEqual({
      from: "extensions@fossbilling.org",
      replyTo: undefined
    });
    expect(
      loadEmailIdentity(
        reader({
          EMAIL_FROM: "extensions@fossbilling.org",
          EMAIL_REPLY_TO: "noreply@fossbilling.org"
        })
      )
    ).toEqual({
      from: "extensions@fossbilling.org",
      replyTo: "noreply@fossbilling.org"
    });
  });

  it("loads a complete mxroute config and rejects an incomplete one", () => {
    expect(loadMxrouteConfig(reader(MXROUTE_VARS), IDENTITY)).toEqual({
      ...IDENTITY,
      server: "tuesday.mxrouting.net",
      username: "extensions@fossbilling.org",
      password: "secret"
    });
    expect(
      loadMxrouteConfig(reader({ EMAIL_PROVIDER: "mxroute" }), IDENTITY)
    ).toBeNull();
  });

  it("loads a complete resend config and rejects a missing key", () => {
    expect(
      loadResendConfig(reader({ RESEND_API_KEY: "re_key" }), IDENTITY)
    ).toEqual({ ...IDENTITY, apiKey: "re_key" });
    expect(loadResendConfig(reader({}), IDENTITY)).toBeNull();
  });
});

describe("notifyRequested", () => {
  it("sends unless explicitly opted out", () => {
    expect(notifyRequested({})).toBe(true);
    expect(notifyRequested({ notify: "true" })).toBe(true);
    expect(notifyRequested({ notify: "false" })).toBe(false);
  });
});

describe("MxrouteSender", () => {
  const config = loadMxrouteConfig(reader(MXROUTE_VARS), IDENTITY)!;
  const message = {
    to: "author@example.com",
    subject: "s",
    html: "<p>hi</p>",
    text: "hi"
  };

  it("posts the SMTP API payload and reports success", async () => {
    const calls: Array<{ url: unknown; init: RequestInit }> = [];
    const sender = new MxrouteSender(config, (async (url, init) => {
      calls.push({ url, init: init as RequestInit });
      return jsonResponse({ success: true, message: "sent" });
    }) as typeof fetch);

    await expect(sender.send(message)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(String(calls[0].url)).toBe("https://smtpapi.mxroute.com/");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      server: "tuesday.mxrouting.net",
      username: "extensions@fossbilling.org",
      from: "extensions@fossbilling.org",
      to: "author@example.com",
      subject: "s"
    });
  });

  it("reports provider failures without throwing", async () => {
    const sender = new MxrouteSender(config, (async () =>
      jsonResponse({
        success: false,
        message: "Invalid server specified."
      })) as typeof fetch);
    await expect(sender.send(message)).resolves.toEqual({
      ok: false,
      error: "Invalid server specified."
    });
  });

  it("reports network errors without throwing", async () => {
    const sender = new MxrouteSender(config, (async () => {
      throw new Error("boom");
    }) as typeof fetch);
    await expect(sender.send(message)).resolves.toEqual({
      ok: false,
      error: "boom"
    });
  });
});

describe("ResendSender", () => {
  const config = loadResendConfig(
    reader({ RESEND_API_KEY: "re_key" }),
    IDENTITY
  )!;

  it("sends with a bearer key", async () => {
    const calls: Array<RequestInit> = [];
    const sender = new ResendSender(config, (async (_url, init) => {
      calls.push(init as RequestInit);
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    await expect(
      sender.send({ to: "a@example.com", subject: "s", html: "h", text: "t" })
    ).resolves.toEqual({ ok: true });
    expect((calls[0].headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer re_key"
    );
  });
});

describe("factory", () => {
  it("returns a disabled sender by default", async () => {
    const sender = createEmailSender(reader({}));
    expect(sender).toBeInstanceOf(DisabledSender);
    await expect(
      sender.send({ to: "a", subject: "s", html: "h", text: "t" })
    ).resolves.toEqual({
      ok: false,
      error: "email notifications are disabled"
    });
  });

  it("selects the configured provider and explains an incomplete one", async () => {
    expect(createEmailSender(reader(MXROUTE_VARS))).toBeInstanceOf(
      MxrouteSender
    );
    expect(
      createEmailSender(reader({ RESEND_API_KEY: "re_key" }))
    ).toBeInstanceOf(DisabledSender);

    const incomplete = createEmailSender(reader({ EMAIL_PROVIDER: "mxroute" }));
    expect(incomplete).toBeInstanceOf(DisabledSender);
    await expect(
      incomplete.send({ to: "a", subject: "s", html: "h", text: "t" })
    ).resolves.toEqual({
      ok: false,
      error: "mxroute credentials are not configured"
    });
  });
});

describe("moderation templates", () => {
  it("includes the reason and escapes markup", () => {
    const message = buildModerationEmail({
      kind: "extension-delisted",
      to: "author@example.com",
      extensionId: "paygate",
      extensionName: "Paygate",
      reason: '<script>alert("x")</script> gone'
    });
    expect(message.subject).toContain("paygate");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).not.toContain("<script>");
    expect(message.text).toContain("gone");
  });

  it("renders every kind with a subject and, where applicable, a dashboard link", () => {
    const kinds = [
      "extension-delisted",
      "revision-approved",
      "revision-rejected",
      "developer-approved",
      "claim-approved",
      "claim-rejected"
    ] as const;
    for (const kind of kinds) {
      const message = buildModerationEmail({
        kind,
        to: "author@example.com",
        extensionId: "paygate",
        extensionName: "Paygate",
        developerId: "paygate-dev",
        developerName: "Paygate Dev",
        reason: "Needs work"
      });
      expect(message.subject).toContain("[FOSSBilling]");
      // A rejected claim leaves the claimant with nothing to open, so its
      // template replies-by-email instead of linking the dashboard.
      if (kind !== "claim-rejected") {
        expect(message.text).toContain("extensions.fossbilling.org/account");
      }
    }
  });
});
