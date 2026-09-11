import { describe, it, expect } from "vitest";
import { getEmailConfig } from "../../../../src/services/extensions/v2/email/config";
import { MxrouteSender } from "../../../../src/services/extensions/v2/email/mxroute";
import { ResendSender } from "../../../../src/services/extensions/v2/email/resend";
import {
  DisabledSender,
  createEmailSender
} from "../../../../src/services/extensions/v2/email/factory";
import { buildModerationEmail } from "../../../../src/services/extensions/v2/email/templates";
import { notifyRequested } from "../../../../src/services/extensions/v2/email/notify";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe("email config", () => {
  it("defaults to disabled with the directory from address", () => {
    expect(getEmailConfig({})).toMatchObject({
      provider: "disabled",
      from: "extensions@fossbilling.org"
    });
  });

  it("accepts mxroute and reads its credentials", () => {
    const config = getEmailConfig({
      EMAIL_PROVIDER: "mxroute",
      EMAIL_FROM: "extensions@fossbilling.org",
      EMAIL_REPLY_TO: "noreply@fossbilling.org",
      MXROUTE_SERVER: "tuesday.mxrouting.net",
      MXROUTE_USERNAME: "extensions@fossbilling.org",
      MXROUTE_PASSWORD: "secret"
    });
    expect(config.provider).toBe("mxroute");
    expect(config.replyTo).toBe("noreply@fossbilling.org");
    expect(config.mxrouteServer).toBe("tuesday.mxrouting.net");
  });

  it("treats unknown providers as disabled", () => {
    expect(getEmailConfig({ EMAIL_PROVIDER: "pigeon" }).provider).toBe(
      "disabled"
    );
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
  const config = getEmailConfig({
    EMAIL_PROVIDER: "mxroute",
    MXROUTE_SERVER: "tuesday.mxrouting.net",
    MXROUTE_USERNAME: "extensions@fossbilling.org",
    MXROUTE_PASSWORD: "secret"
  });
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

  it("reports missing credentials without a network call", async () => {
    const sender = new MxrouteSender(
      getEmailConfig({ EMAIL_PROVIDER: "mxroute" }),
      (async () => {
        throw new Error("must not be called");
      }) as typeof fetch
    );
    const result = await sender.send(message);
    expect(result.ok).toBe(false);
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
  it("reports a missing api key without a network call", async () => {
    const sender = new ResendSender(
      getEmailConfig({ EMAIL_PROVIDER: "resend" }),
      (async () => {
        throw new Error("must not be called");
      }) as typeof fetch
    );
    const result = await sender.send({
      to: "a@example.com",
      subject: "s",
      html: "<p>hi</p>",
      text: "hi"
    });
    expect(result.ok).toBe(false);
  });

  it("sends with a bearer key", async () => {
    const calls: Array<RequestInit> = [];
    const sender = new ResendSender(
      getEmailConfig({
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_key"
      }),
      (async (_url, init) => {
        calls.push(init as RequestInit);
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    );
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
    const sender = createEmailSender({});
    expect(sender).toBeInstanceOf(DisabledSender);
    await expect(
      sender.send({ to: "a", subject: "s", html: "h", text: "t" })
    ).resolves.toEqual({ ok: false, error: "email provider is disabled" });
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

  it("renders every kind with a subject and, where there is something to view, a dashboard link", () => {
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
