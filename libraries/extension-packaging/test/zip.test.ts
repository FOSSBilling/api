import { describe, expect, it } from "vitest";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { validateExtensionPackage } from "../src/zip";
import { PACKAGE_LIMITS } from "../src/limits";

const manifest = {
  manifest_version: 1,
  type: "module",
  id: "demo",
  name: "Demo",
  version: "1.2.0",
  description: "Example extension",
  author: { name: "Example Developer" },
  license: "Apache-2.0",
  requires: { fossbilling: ">=0.8.0" }
};
const options = { useWebWorkers: false, useCompressionStream: true };
async function zip(
  files: [string, string][],
  entryOptions: Parameters<ZipWriter<Uint8Array<ArrayBuffer>>["add"]>[2] = {}
) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), options);
  for (const [name, content] of files) {
    await writer.add(name, new TextReader(content), entryOptions);
  }
  return writer.close();
}
describe("ZIP validation", () => {
  it("stops ZIP processing when its caller aborts", async () => {
    const source = await zip([["Service.php", "<?php // package source"]]);
    const controller = new AbortController();
    const processing = validateExtensionPackage(source, controller.signal);
    controller.abort();
    await expect(processing).rejects.toThrow();
  });
  it("rejects overlong and deeply nested paths before walking ancestors", async () => {
    for (const path of [
      "a/".repeat(20000) + "file.php",
      "a/".repeat(PACKAGE_LIMITS.pathDepth) + "file.php",
      "a".repeat(PACKAGE_LIMITS.pathLength + 1)
    ]) {
      await expect(
        validateExtensionPackage(await zip([[path, "file"]]))
      ).rejects.toThrow(/path exceeds/);
    }
    const path = "a/".repeat(PACKAGE_LIMITS.pathDepth - 1) + "file.php";
    await expect(
      validateExtensionPackage(
        await zip([
          [path, "file"],
          ["manifest.json", JSON.stringify(manifest)]
        ])
      )
    ).resolves.toMatchObject({ manifest });
  });
  it("reads metadata from a root manifest alongside ordinary directory entries", async () => {
    const source = await zip([
      ["manifest.json", JSON.stringify(manifest)],
      ["assets/", ""],
      ["assets/example.css", "body {}"]
    ]);
    await expect(validateExtensionPackage(source)).resolves.toMatchObject({
      manifest
    });
  });

  it.each(["svg", "png", "webp", "avif"])(
    "discovers icon.%s without a manifest field",
    async (format) => {
      const source = await zip([
        [`icon.${format}`, "image bytes"],
        ["file.php", "<?php"],
        ["manifest.json", JSON.stringify(manifest)]
      ]);
      const built = await validateExtensionPackage(source);
      const icon = built.icon;
      expect(new TextDecoder().decode(icon!)).toBe("image bytes");
      expect(built.manifest).not.toHaveProperty("icon_url");
    }
  );
  it("rejects multiple convention icons and manifest icon fields", async () => {
    const source = await zip([
      ["icon.svg", "svg"],
      ["icon.png", "png"]
    ]);
    await expect(validateExtensionPackage(source)).rejects.toThrow("only one");
    await expect(
      validateExtensionPackage(
        await zip([
          ["file.php", "<?php"],
          [
            "manifest.json",
            JSON.stringify({ ...manifest, icon_url: "icon.svg" })
          ]
        ])
      )
    ).rejects.toThrow();
  });
  it("does not discover nested or unrelated images", async () => {
    const result = await validateExtensionPackage(
      await zip([
        ["assets/icon.svg", "image"],
        ["manifest.json", JSON.stringify(manifest)]
      ])
    );
    expect(result.icon).toBeUndefined();
  });

  it("requires a root manifest with valid metadata", async () => {
    await expect(
      validateExtensionPackage(await zip([["file.php", "<?php"]]))
    ).rejects.toThrow("root manifest.json");
    await expect(
      validateExtensionPackage(
        await zip([
          ["file.php", "<?php"],
          ["manifest.json", JSON.stringify({ ...manifest, version: "nope" })]
        ])
      )
    ).rejects.toThrow();
  });

  it("rejects a manifest with a UTF-8 byte order mark", async () => {
    const source = await zip([
      ["file.php", "<?php"],
      ["manifest.json", "\uFEFF" + JSON.stringify(manifest)]
    ]);
    await expect(validateExtensionPackage(source)).rejects.toThrow(
      "without a byte order mark"
    );
  });

  it.each([
    "../outside.php",
    "/absolute.php",
    "C:/drive.php",
    "a\\b.php",
    "a/./b.php",
    "a//b.php",
    "a./b.php",
    "NUL.txt"
  ])("rejects unsafe path %s", async (path) => {
    await expect(
      validateExtensionPackage(await zip([[path, "test"]]))
    ).rejects.toThrow(/Unsafe/);
  });

  it("rejects case collisions, file/directory conflicts and symlinks", async () => {
    await expect(
      validateExtensionPackage(
        await zip([
          ["A.php", "a"],
          ["a.php", "b"]
        ])
      )
    ).rejects.toThrow("Duplicate package path");
    await expect(
      validateExtensionPackage(
        await zip([
          ["dir", "a"],
          ["dir/file.php", "b"]
        ])
      )
    ).rejects.toThrow("File conflicts");
    await expect(
      validateExtensionPackage(
        await zip([["link", "../outside"]], { unixMode: 0o120777 })
      )
    ).rejects.toThrow("Unsupported package entry");
  });

  it("rejects files beneath the reserved manifest path", async () => {
    await expect(
      validateExtensionPackage(await zip([["manifest.json/file.php", "bad"]]))
    ).rejects.toThrow("Manifest path is a directory");
  });

  it("rejects encrypted files and truncated archives", async () => {
    await expect(
      validateExtensionPackage(
        await zip([["file", "secret"]], { password: "test" })
      )
    ).rejects.toThrow("Unsupported package entry");
    const source = await zip([["file", "content"]]);
    await expect(
      validateExtensionPackage(source.slice(0, -30))
    ).rejects.toThrow();
  });

  it.each(["manifest.json", "file.php"])(
    "checks CRCs for %s",
    async (filename) => {
      const source = await zip(
        [
          [filename, "unique-contents"],
          ["Service.php", "<?php // source"]
        ],
        { level: 0 }
      );
      const contents = new TextEncoder().encode("unique-contents");
      // ZIP headers are binary: decoded string offsets are not byte offsets.
      const offset = source.findIndex((_, index) =>
        contents.every((byte, part) => source[index + part] === byte)
      );
      expect(offset).toBeGreaterThan(0);
      source[offset] ^= 1;
      await expect(validateExtensionPackage(source)).rejects.toThrow(
        "Invalid CRC32"
      );
    }
  );

  it.each([-1, 1])(
    "rejects inconsistent uncompressed sizes (%i)",
    async (difference) => {
      const source = await zip([["file.php", "unique-contents"]]);
      const view = new DataView(
        source.buffer,
        source.byteOffset,
        source.byteLength
      );
      view.setUint32(22, "unique-contents".length + difference, true);
      for (let offset = 0; offset < source.length - 46; offset++) {
        if (view.getUint32(offset, true) === 0x08074b50) {
          view.setUint32(
            offset + 12,
            "unique-contents".length + difference,
            true
          );
        }
        if (view.getUint32(offset, true) === 0x02014b50) {
          view.setUint32(
            offset + 24,
            "unique-contents".length + difference,
            true
          );
          break;
        }
      }
      await expect(validateExtensionPackage(source)).rejects.toThrow();
    }
  );

  it("rejects oversized inputs and expansion bombs", async () => {
    await expect(
      validateExtensionPackage(new Uint8Array(PACKAGE_LIMITS.sourceBytes + 1))
    ).rejects.toThrow("Source ZIP exceeds size limit");
    const source = await zip([
      ["large.txt", "x".repeat(PACKAGE_LIMITS.expandedBytes + 1)]
    ]);
    expect(source.byteLength).toBeLessThan(PACKAGE_LIMITS.sourceBytes);
    await expect(validateExtensionPackage(source)).rejects.toThrow(
      "expanded size limit"
    );
  });

  it("rejects entry floods and manifest-only archives", async () => {
    const source = await zip(
      Array.from({ length: PACKAGE_LIMITS.entries + 1 }, (_, i) => [
        `file-${i}`,
        ""
      ])
    );
    await expect(validateExtensionPackage(source)).rejects.toThrow(
      "entry limit"
    );
    await expect(
      validateExtensionPackage(await zip([["manifest.json", "{}"]]))
    ).rejects.toThrow("no source files");
  });
});
