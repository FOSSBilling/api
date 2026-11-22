import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter
} from "@zip.js/zip.js";
import sharp from "sharp";
import { createServer } from "node:http";
import { once } from "node:events";
import { handlePackageProcessing } from "../src/handler";
import { HttpPackageProcessor } from "@fossbilling/extension-packaging/adapters/http";
import { sha256 } from "@fossbilling/extension-packaging/checksum";
import type { ProcessingInput } from "@fossbilling/extension-packaging/processor";

const encode = (text: string) => new Uint8Array(new TextEncoder().encode(text));

const manifest = {
  manifest_version: 1 as const,
  id: "processor-example",
  type: "module" as const,
  name: "Processor Example",
  version: "1.0.0",
  description: "Local processor test",
  author: { name: "Developer" },
  license: "MIT",
  requires: { fossbilling: ">=0.7.0", php: ">=8.3" }
};
const config: Record<string, string> = {
  EXTENSION_PACKAGE_PROCESSOR_SECRET: "local-test-secret",
  EXTENSION_PACKAGES_S3_ENDPOINT: "https://s3.test-region.backblazeb2.com",
  EXTENSION_PACKAGES_S3_BUCKET: "private-packages",
  EXTENSION_PACKAGES_S3_ACCESS_KEY_ID: "test-key",
  EXTENSION_PACKAGES_S3_SECRET_ACCESS_KEY: "test-secret"
};
const options = { useWebWorkers: false, useCompressionStream: true };
const svg = `<?xml version="1.0"?><?xml-stylesheet href="https://untrusted.example/style.xsl" type="text/xsl"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="512" height="256" onload="alert(1)">
<script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">HTML</div></foreignObject>
<defs><linearGradient id="paint"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>
<path d="M0 0h24v24H0z" fill="url(#paint)"/><image href="https://untrusted.example/tracker.png"/>
</svg>`;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function archive(iconName = "icon.svg", icon = encode(svg)) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), options);
  await writer.add("manifest.json", new TextReader(JSON.stringify(manifest)));
  await writer.add(
    "Service.php",
    new TextReader("<?php // Ready-made package; never executed")
  );
  await writer.add(iconName, new Uint8ArrayReader(icon));
  return writer.close();
}
function fixture() {
  const nativeFetch = globalThis.fetch;
  const objects = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; checksum: string }
  >();
  const key = (id: string) => "/private-packages/packages/" + id;
  const handler = (request: Request) =>
    handlePackageProcessing(request, (name) => config[name]);
  const fetch = vi.fn(
    async (input: Request | string | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "processor.example.test") return handler(request);
      if (url.hostname === "127.0.0.1") return nativeFetch(request);
      if (url.hostname !== "s3.test-region.backblazeb2.com")
        throw new Error("Unexpected network request");
      expect(request.cache).toBe("no-store");
      if (request.method === "PUT") {
        objects.set(url.pathname, {
          bytes: new Uint8Array(await request.arrayBuffer()),
          checksum: request.headers.get("x-amz-meta-sha256")!
        });
        return new Response(null);
      }
      const value = objects.get(url.pathname);
      return value
        ? new Response(value.bytes, {
            headers: { "x-amz-meta-sha256": value.checksum }
          })
        : new Response(null, { status: 404 });
    }
  );
  vi.stubGlobal("fetch", fetch);
  const processor = new HttpPackageProcessor(
    "https://processor.example.test/process",
    config.EXTENSION_PACKAGE_PROCESSOR_SECRET
  );
  const input = async (bytes: Uint8Array<ArrayBuffer>) => {
    const id = crypto.randomUUID(),
      checksum = await sha256(bytes);
    objects.set(key(id), { bytes, checksum });
    return {
      target: { id: manifest.id, version: manifest.version },
      source: { id, sha256: checksum },
      archive: crypto.randomUUID(),
      icons: [crypto.randomUUID(), crypto.randomUUID()]
    } satisfies ProcessingInput;
  };
  return { objects, key, fetch, handler, processor, input };
}
describe("Node package processor over the generic HTTP contract", () => {
  it("seals the unchanged ZIP privately and sanitizes a separate display SVG", async () => {
    const f = fixture(),
      input = await f.input(await archive());
    const result = await f.processor.process(input);
    const bytes = f.objects.get(f.key(input.archive))!.bytes;
    expect(bytes).toEqual(f.objects.get(f.key(input.source.id))!.bytes);
    expect(result.archive.sha256).toBe(input.source.sha256);
    expect(result.manifest).toEqual(manifest);
    const image = f.objects.get(f.key(result.icons[0].id))!.bytes;
    const prepared = new TextDecoder().decode(image);
    expect(prepared).not.toMatch(
      /script|onload|foreignObject|untrusted\.example|xml-stylesheet/
    );
    expect(prepared).toContain("linearGradient");
    expect(prepared).toContain("url(#paint)");
    expect(prepared).toContain('viewBox="0 0 24 24"');
  });
  it.each([false, true])(
    "checks the GitHub asset checksum before storing the original ZIP (changed: %s)",
    async (changed) => {
      const f = fixture();
      const repository = "fossbilling/modules";
      const assetId = 123;
      const source = await archive();
      const input = {
        target: { id: manifest.id },
        source: {
          github: { repository, assetId, bytes: source.length },
          sha256: await sha256(source)
        },
        archive: crypto.randomUUID(),
        icons: [crypto.randomUUID(), crypto.randomUUID()]
      } satisfies ProcessingInput;
      const downloadUrl =
        "https://release-assets.githubusercontent.com/test.zip";
      const fetch = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (request, init) => {
        const url = request instanceof Request ? request.url : String(request);
        if (
          url ===
          `https://api.github.com/repos/${repository}/releases/assets/${assetId}`
        ) {
          expect(new Headers(init?.headers).get("Accept")).toBe(
            "application/octet-stream"
          );
          return Response.redirect(downloadUrl, 302);
        }
        if (url === downloadUrl)
          return new Response(
            changed ? source.map((byte) => byte ^ 1) : source
          );
        return fetch(request, init);
      });
      if (changed) {
        await expect(f.processor.process(input)).rejects.toMatchObject({
          code: "INVALID_PACKAGE",
          message: expect.stringContaining("checksum")
        });
        expect(f.objects.size).toBe(0);
      } else {
        const result = await f.processor.process(input);
        expect(result.manifest).toEqual(manifest);
        expect(f.objects.size).toBe(1 + result.icons.length);
        expect(f.objects.get(f.key(input.archive))).toEqual({
          bytes: source,
          checksum: input.source.sha256
        });
      }
    }
  );
  it.each(["png", "webp", "avif"] as const)(
    "prepares real icon.%s as AVIF and PNG with preserved proportions",
    async (format) => {
      const f = fixture();
      const original = new Uint8Array(
        await sharp({
          create: {
            width: 512,
            height: 256,
            channels: 4,
            background: "#2364ff80"
          }
        })
          .toFormat(format)
          .toBuffer()
      );
      const result = await f.processor.process(
        await f.input(await archive("icon." + format, original))
      );
      expect(result.icons.map((i) => i.format)).toEqual(["avif", "png"]);
      for (const icon of result.icons) {
        const bytes = f.objects.get(f.key(icon.id))!.bytes;
        const info = await sharp(bytes).metadata();
        expect(info).toMatchObject({
          format: icon.format === "avif" ? "heif" : "png",
          width: 256,
          height: 128
        });
        expect(await sha256(bytes)).toBe(icon.sha256);
      }
    }
  );
  it("sanitizes SVG masquerading as a raster icon and rejects invalid images before writing outputs", async () => {
    const f = fixture();
    const result = await f.processor.process(
      await f.input(await archive("icon.png"))
    );
    expect(result.icons[0].format).toBe("svg");
    const sanitized = f.objects.get(f.key(result.icons[0].id))!.bytes;
    expect(new TextDecoder().decode(sanitized)).not.toMatch(/<script|onload/);
    for (const [name, bytes] of [
      ["icon.svg", encode("<svg")],
      ["icon.svg", encode('<html xmlns="http://www.w3.org/1999/xhtml"/>')],
      [
        "icon.svg",
        encode(
          '<svg xmlns="http://www.w3.org/2000/svg"><!--' +
            "x".repeat(2 * 1024 * 1024) +
            "--></svg>"
        )
      ],
      ["icon.png", encode("not an image")]
    ] as const) {
      const input = await f.input(await archive(name, bytes));
      await expect(f.processor.process(input)).rejects.toMatchObject({
        code: "INVALID_ICON",
        status: 422
      });
      expect(f.objects.has(f.key(input.archive))).toBe(false);
    }
  });
  it("rejects a manifest that does not match the upload target", async () => {
    const f = fixture();
    const input = await f.input(await archive());
    input.target.version = "2.0.0";
    await expect(f.processor.process(input)).rejects.toMatchObject({
      code: "INVALID_PACKAGE",
      status: 422
    });
    expect(f.objects.has(f.key(input.archive))).toBe(false);
  });
  it.each([
    "timeout: 10% complete",
    "Could not allocate enough memory for raw output"
  ])("keeps image processing failure retryable: %s", async (message) => {
    const f = fixture();
    const png = new Uint8Array(
      await sharp({
        create: { width: 1, height: 1, channels: 4, background: "red" }
      })
        .png()
        .toBuffer()
    );
    const input = await f.input(await archive("icon.png", png));
    vi.spyOn(sharp.prototype, "toBuffer").mockRejectedValueOnce(
      new Error(message)
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(f.processor.process(input)).rejects.toMatchObject({
      status: 503
    });
    expect(f.objects.has(f.key(input.archive))).toBe(false);
  });
  it("preserves a missing source error through the HTTP processor", async () => {
    const f = fixture();
    const input = await f.input(await archive());
    f.objects.delete(f.key(input.source.id));
    await expect(f.processor.process(input)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      status: 503
    });
    expect(f.objects.has(f.key(input.archive))).toBe(false);
  });
  it("rejects unauthenticated and invalid requests before storage access", async () => {
    const f = fixture();
    expect(
      (
        await f.handler(
          new Request("https://processor.example.test", {
            method: "POST",
            body: "{}"
          })
        )
      ).status
    ).toBe(401);
    expect(f.fetch).not.toHaveBeenCalled();
    const response = await f.handler(
      new Request("https://processor.example.test", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + config.EXTENSION_PACKAGE_PROCESSOR_SECRET
        },
        body: "{}"
      })
    );
    expect(response.status).toBe(422);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rejects invalid archives and changed source bytes without writing outputs", async () => {
    const f = fixture(),
      input = await f.input(encode("not a ZIP"));
    await expect(f.processor.process(input)).rejects.toMatchObject({
      code: "INVALID_PACKAGE",
      status: 422
    });
    expect(f.objects.size).toBe(1);
    const valid = await f.input(await archive());
    f.objects.get(f.key(valid.source.id))!.bytes = new Uint8Array([1, 2, 3]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(f.processor.process(valid)).rejects.toMatchObject({
      status: 503
    });
    expect(f.objects.has(f.key(valid.archive))).toBe(false);
  });
  it("processes a near-limit ZIP over a real local HTTP connection with a small JSON response", async () => {
    const f = fixture();
    const writer = new ZipWriter(new Uint8ArrayWriter(), options);
    await writer.add("manifest.json", new TextReader(JSON.stringify(manifest)));
    for (let i = 0; i < 499; i++) {
      const bytes = new Uint8Array(33000);
      crypto.getRandomValues(bytes.subarray(0, 9900));
      await writer.add(`files/file-${i}.bin`, new Uint8ArrayReader(bytes));
    }
    const source = await writer.close();
    expect(source.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(source.length).toBeGreaterThan(4.5 * 1024 * 1024);
    const input = await f.input(source);
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await f.handler(
        new Request("http://localhost/process", {
          method: "POST",
          headers: { Authorization: String(req.headers.authorization) },
          body: Buffer.concat(chunks)
        })
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(new Uint8Array(await response.arrayBuffer()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing HTTP port");
      const processor = new HttpPackageProcessor(
        `http://127.0.0.1:${address.port}/process`,
        config.EXTENSION_PACKAGE_PROCESSOR_SECRET,
        true
      );
      const result = await processor.process(input);
      expect(result.archive.bytes).toBeGreaterThan(4.5 * 1024 * 1024);
      expect(result.icons).toEqual([]);
      expect(JSON.stringify(result).length).toBeLessThan(1024);
      expect(await sha256(f.objects.get(f.key(input.archive))!.bytes)).toBe(
        result.archive.sha256
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }, 30000);
  it("fails closed on malformed runner responses and leaves timeouts retryable", async () => {
    const input = await fixture().input(await archive());
    const processor = new HttpPackageProcessor(
      "https://processor.example.test/process",
      "secret"
    );
    for (const result of [
      {
        manifest,
        archive: { bytes: -1, sha256: input.source.sha256 },
        icons: []
      },
      {
        manifest,
        archive: { bytes: 20, sha256: input.source.sha256 },
        icons: [
          {
            id: crypto.randomUUID(),
            format: "svg",
            bytes: 10,
            sha256: "0".repeat(64)
          }
        ]
      }
    ]) {
      vi.stubGlobal("fetch", async () => Response.json({ result }));
      await expect(processor.process(input)).rejects.toMatchObject({
        status: 503
      });
    }
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      (request: Request) =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true }
          )
        )
    );
    const timedOut = expect(processor.process(input)).rejects.toMatchObject({
      status: 503
    });
    controller.abort(new DOMException("Processor timed out", "TimeoutError"));
    await timedOut;
  });
});
