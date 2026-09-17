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
  EXTENSIONS_V2_EMAIL_PROVIDER: "mxroute",
  EXTENSIONS_V2_MXROUTE_SERVER: "tuesday.mxrouting.net",
  EXTENSIONS_V2_MXROUTE_USERNAME: "extensions@fossbilling.org",
  EXTENSIONS_V2_MXROUTE_PASSWORD: "secret"
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe("email config", () => {
  it("resolves no provider by default", () => {
    expect(resolveEmailProvider(reader({}))).toBeNull();
    expect(
      resolveEmailProvider(reader({ EXTENSIONS_V2_EMAIL_PROVIDER: "pigeon" }))
    ).toBeNull();
  });

  it("resolves the selected provider case-insensitively", () => {
    expect(
      resolveEmailProvider(reader({ EXTENSIONS_V2_EMAIL_PROVIDER: "MXRoute" }))
    ).toBe("mxroute");
    expect(
      resolveEmailProvider(reader({ EXTENSIONS_V2_EMAIL_PROVIDER: "resend" }))
    ).toBe("resend");
  });

  it("loads the sender identity with the noreply default", () => {
    expect(loadEmailIdentity(reader({}))).toEqual({
      from: "noreply@fossbilling.org",
      replyTo: undefined
    });
    expect(
      loadEmailIdentity(
        reader({
          EXTENSIONS_V2_EMAIL_FROM: "extensions@fossbilling.org",
          EXTENSIONS_V2_EMAIL_REPLY_TO: "extensions@fossbilling.org"
        })
      )
    ).toEqual({
      from: "extensions@fossbilling.org",
      replyTo: "extensions@fossbilling.org"
    });
    expect(
      loadEmailIdentity(reader({ EXTENSIONS_V2_EMAIL_FROM: "  " })).from
    ).toBe("noreply@fossbilling.org");
  });

  it("loads a complete mxroute config and rejects an incomplete one", () => {
    expect(loadMxrouteConfig(reader(MXROUTE_VARS), IDENTITY)).toEqual({
      ...IDENTITY,
      server: "tuesday.mxrouting.net",
      username: "extensions@fossbilling.org",
      password: "secret"
    });
    expect(
      loadMxrouteConfig(
        reader({ EXTENSIONS_V2_EMAIL_PROVIDER: "mxroute" }),
        IDENTITY
      )
    ).toBeNull();
  });

  it("loads a complete resend config and rejects a missing key", () => {
    expect(
      loadResendConfig(
        reader({ EXTENSIONS_V2_RESEND_API_KEY: "re_key" }),
        IDENTITY
      )
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
    // No monitored inbox is configured, so no Reply-To may be sent.
    expect(body.reply_to).toBeUndefined();
  });

  it("forwards replyTo as reply_to when a monitored inbox is configured", async () => {
    const configWithReply = loadMxrouteConfig(reader(MXROUTE_VARS), {
      from: "extensions@fossbilling.org",
      replyTo: "extensions@fossbilling.org"
    })!;
    const calls: Array<{ url: unknown; init: RequestInit }> = [];
    const sender = new MxrouteSender(configWithReply, (async (url, init) => {
      calls.push({ url, init: init as RequestInit });
      return jsonResponse({ success: true, message: "sent" });
    }) as typeof fetch);

    await expect(sender.send(message)).resolves.toEqual({ ok: true });
    expect(JSON.parse(String(calls[0].init.body)).reply_to).toBe(
      "extensions@fossbilling.org"
    );
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

  it("reports a null JSON payload as a failure without throwing", async () => {
    const sender = new MxrouteSender(config, (async () =>
      jsonResponse(null)) as typeof fetch);
    await expect(sender.send(message)).resolves.toEqual({
      ok: false,
      error: "unexpected status 200"
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
    reader({ EXTENSIONS_V2_RESEND_API_KEY: "re_key" }),
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

  it("reports a null JSON payload as a failure without throwing", async () => {
    const sender = new ResendSender(config, (async () =>
      jsonResponse(null, 500)) as typeof fetch);
    await expect(
      sender.send({ to: "a@example.com", subject: "s", html: "h", text: "t" })
    ).resolves.toEqual({ ok: false, error: "unexpected status 500" });
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

    const incompleteResend = createEmailSender(
      reader({ EXTENSIONS_V2_EMAIL_PROVIDER: "resend" })
    );
    expect(incompleteResend).toBeInstanceOf(DisabledSender);
    await expect(
      incompleteResend.send({ to: "a", subject: "s", html: "h", text: "t" })
    ).resolves.toEqual({
      ok: false,
      error: "resend api key is not configured"
    });

    const incomplete = createEmailSender(
      reader({ EXTENSIONS_V2_EMAIL_PROVIDER: "mxroute" })
    );
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

  it("strips CR/LF from names before interpolating the subject", () => {
    const message = buildModerationEmail({
      kind: "extension-delisted",
      to: "author@example.com",
      extensionId: "paygate",
      extensionName: "Bad\r\nHeader: injected",
      reason: "gone"
    });
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.subject).toContain("Bad Header: injected");
  });

  it("folds non-ASCII names to ASCII-safe subjects", () => {
    const message = buildModerationEmail({
      kind: "extension-delisted",
      to: "author@example.com",
      extensionId: "paygate",
      extensionName: "“Smöké — Test”",
      reason: "gone"
    });
    // MXroute declares subjects iso-8859-1 while receiving UTF-8, so any
    // non-ASCII byte would render as mojibake.
    expect(message.subject).toMatch(/^[\u0020-\u007E]*$/);
    expect(message.subject).toContain('"Smoke - Test"');
    // The body keeps the original characters: entities in HTML, raw in text.
    expect(message.text).toContain(
      "\u201cSm\u00f6k\u00e9 \u2014 Test\u201d (paygate)"
    );
    expect(message.html).toContain("Sm&#246;k&#233; &#8212; Test");
    expect(message.html).not.toContain("Sm\u00f6k\u00e9");
  });

  it("preserves original developer names in the body", () => {
    const message = buildModerationEmail({
      kind: "claim-rejected",
      to: "author@example.com",
      developerId: "tokyo-dev",
      developerName: "\u6771\u4eac Dev",
      reason: "Could not verify"
    });
    expect(message.subject).toContain("tokyo-dev");
    expect(message.text).toContain("\u201c\u6771\u4eac Dev\u201d (tokyo-dev)");
    expect(message.html).toContain(
      "&#8220;&#26481;&#20140; Dev&#8221; (tokyo-dev)"
    );
    expect(message.html).not.toContain("\u6771\u4eac");
  });

  it("encodes non-ASCII as HTML entities while keeping text raw", () => {
    const message = buildModerationEmail({
      kind: "claim-rejected",
      to: "author@example.com",
      developerId: "paygate-dev",
      developerName: "Paygate Dev",
      reason: "Ownership “unverified” — see notes"
    });
    expect(message.html).toMatch(/^[\u0020-\u007E]*$/);
    expect(message.html).toContain("&#8220;unverified&#8221; &#8212;");
    // The plain-text part (used by Resend, which is UTF-8 clean) keeps
    // readable unicode.
    expect(message.text).toContain("“unverified” — see notes");
  });

  it("links dashboard URLs as anchors in HTML but not in text", () => {
    const message = buildModerationEmail({
      kind: "revision-approved",
      to: "author@example.com",
      extensionId: "paygate",
      extensionName: "Paygate"
    });
    expect(message.html).toContain(
      '<a href="https://extensions.fossbilling.org/account">https://extensions.fossbilling.org/account</a>'
    );
    expect(message.text).toContain(
      "https://extensions.fossbilling.org/account"
    );
    expect(message.text).not.toContain("<a href=");
  });

  it("renders every kind with a subject, a dashboard link, and a complete HTML document", () => {
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
      expect(message.text).toContain("extensions.fossbilling.org/account");
      expect(message.html).toContain("<html><body>");
      expect(message.html).toContain("</body></html>");
    }
  });
});
