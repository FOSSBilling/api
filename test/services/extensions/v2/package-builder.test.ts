import { describe, expect, it } from "vitest";
import {
  TextReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter
} from "@zip.js/zip.js";
import {
  buildExtensionPackage,
  PACKAGE_LIMITS,
  sha256
} from "../../../../src/services/extensions/v2/package-builder";

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
async function contents(bytes: Uint8Array<ArrayBuffer>) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), options);
  try {
    const result: Record<string, string> = {};
    for await (const entry of reader.getEntriesGenerator()) {
      if (!entry.directory)
        result[entry.filename] = await entry.getData(new TextWriter());
    }
    return result;
  } finally {
    await reader.close();
  }
}

describe("local directory package builder", () => {
  it("rejects overlong and deeply nested paths before walking ancestors", async () => {
    for (const path of [
      "a/".repeat(20000) + "file.php",
      "a/".repeat(PACKAGE_LIMITS.pathDepth) + "file.php",
      "a".repeat(PACKAGE_LIMITS.pathLength + 1)
    ]) {
      await expect(
        buildExtensionPackage(await zip([[path, "file"]]), manifest)
      ).rejects.toThrow(/path exceeds/);
    }
    const path = "a/".repeat(PACKAGE_LIMITS.pathDepth - 1) + "file.php";
    expect(
      (await buildExtensionPackage(await zip([[path, "file"]]), manifest))
        .sourceFileCount
    ).toBe(1);
  });
  it("replaces the manifest and preserves every source file", async () => {
    const source = await zip([
      ["manifest.json", "old metadata"],
      ["Service.php", "<?php // not executed"],
      ["assets/logo.svg", "<svg />"]
    ]);
    const built = await buildExtensionPackage(source, manifest);
    expect(await contents(built.bytes)).toEqual({
      "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
      "Service.php": "<?php // not executed",
      "assets/logo.svg": "<svg />"
    });
    expect(built.sourceFileCount).toBe(2);
    expect(built.sourceSha256).toBe(await sha256(source));
    expect(built.packageSha256).toBe(await sha256(built.bytes));
    const repeated = await buildExtensionPackage(source, manifest);
    expect(repeated.packageSha256).toBe(built.packageSha256);
    const correction = await buildExtensionPackage(source, {
      ...manifest,
      description: "Corrected description"
    });
    expect(correction.sourceSha256).toBe(built.sourceSha256);
    expect(correction.manifest.version).toBe(built.manifest.version);
    expect(correction.packageSha256).not.toBe(built.packageSha256);
  });

  it.each([0, 8])(
    "preserves the exact compressed payload for method %i",
    async (compressionMethod) => {
      const source = await zip(
        [["file.php", "<?php // repeated contents\n".repeat(2000)]],
        { compressionMethod, level: 1 }
      );
      const built = await buildExtensionPackage(source, manifest);
      async function payload(bytes: Uint8Array<ArrayBuffer>) {
        const reader = new ZipReader(new Uint8ArrayReader(bytes), options);
        try {
          const entries = await reader.getEntries();
          const entry = entries.find((entry) => entry.filename === "file.php")!;
          if (!entry || entry.directory)
            throw new Error("Expected a regular file");
          return {
            method: entry.compressionMethod,
            bytes: await entry.getData(new Uint8ArrayWriter(), {
              passThrough: true
            })
          };
        } finally {
          await reader.close();
        }
      }
      const original = await payload(source);
      expect(original.method).toBe(compressionMethod);
      expect(await payload(built.bytes)).toEqual(original);
      expect((await contents(built.bytes))["file.php"]).toBe(
        "<?php // repeated contents\n".repeat(2000)
      );
    }
  );

  it.each(["svg", "png", "webp", "avif"])(
    "discovers icon.%s without a manifest field",
    async (format) => {
      const source = await zip([
        [`icon.${format}`, "image bytes"],
        ["file.php", "<?php"]
      ]);
      const built = await buildExtensionPackage(source, manifest);
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
    await expect(buildExtensionPackage(source, manifest)).rejects.toThrow(
      "only one"
    );
    await expect(
      buildExtensionPackage(await zip([["file.php", "<?php"]]), {
        ...manifest,
        icon_url: "icon.svg"
      })
    ).rejects.toThrow();
  });
  it("does not discover nested or unrelated images", async () => {
    const built = await buildExtensionPackage(
      await zip([["assets/icon.svg", "image"]]),
      manifest
    );
    expect(built.icon).toBeNull();
  });

  it("inserts a missing manifest and rejects invalid metadata", async () => {
    const source = await zip([["file.php", "<?php"]]);
    const built = await buildExtensionPackage(source, manifest);
    expect(JSON.parse((await contents(built.bytes))["manifest.json"])).toEqual(
      manifest
    );
    await expect(
      buildExtensionPackage(source, { ...manifest, version: "nope" })
    ).rejects.toThrow();
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
      buildExtensionPackage(await zip([[path, "test"]]), manifest)
    ).rejects.toThrow(/Unsafe/);
  });

  it("rejects case collisions, file/directory conflicts and symlinks", async () => {
    await expect(
      buildExtensionPackage(
        await zip([
          ["A.php", "a"],
          ["a.php", "b"]
        ]),
        manifest
      )
    ).rejects.toThrow("Duplicate package path");
    await expect(
      buildExtensionPackage(
        await zip([
          ["dir", "a"],
          ["dir/file.php", "b"]
        ]),
        manifest
      )
    ).rejects.toThrow("File conflicts");
    await expect(
      buildExtensionPackage(
        await zip([["link", "../outside"]], { unixMode: 0o120777 }),
        manifest
      )
    ).rejects.toThrow("Unsupported package entry");
  });

  it("rejects files beneath the reserved manifest path", async () => {
    await expect(
      buildExtensionPackage(
        await zip([["manifest.json/file.php", "bad"]]),
        manifest
      )
    ).rejects.toThrow("Manifest path is a directory");
  });

  it("rejects encrypted files and truncated archives", async () => {
    await expect(
      buildExtensionPackage(
        await zip([["file", "secret"]], { password: "test" }),
        manifest
      )
    ).rejects.toThrow("Unsupported package entry");
    const source = await zip([["file", "content"]]);
    await expect(
      buildExtensionPackage(source.slice(0, -30), manifest)
    ).rejects.toThrow();
  });

  it.each(["manifest.json", "file.php"])(
    "checks CRCs before copying or replacing %s",
    async (filename) => {
      const source = await zip([[filename, "unique-contents"]], {
        level: 0
      });
      const offset = new TextDecoder()
        .decode(source)
        .indexOf("unique-contents");
      expect(offset).toBeGreaterThan(0);
      source[offset] ^= 1;
      await expect(buildExtensionPackage(source, manifest)).rejects.toThrow();
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
      await expect(buildExtensionPackage(source, manifest)).rejects.toThrow();
    }
  );

  it("rejects oversized inputs and expansion bombs", async () => {
    await expect(
      buildExtensionPackage(
        new Uint8Array(PACKAGE_LIMITS.sourceBytes + 1),
        manifest
      )
    ).rejects.toThrow("Source ZIP exceeds size limit");
    const source = await zip([
      ["large.txt", "x".repeat(PACKAGE_LIMITS.expandedBytes + 1)]
    ]);
    expect(source.byteLength).toBeLessThan(PACKAGE_LIMITS.sourceBytes);
    await expect(buildExtensionPackage(source, manifest)).rejects.toThrow(
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
    await expect(buildExtensionPackage(source, manifest)).rejects.toThrow(
      "entry limit"
    );
    await expect(
      buildExtensionPackage(await zip([["manifest.json", "{}"]]), manifest)
    ).rejects.toThrow("no source files");
  });

  it("builds and reads back a representative multi-file package in Workers", async () => {
    const source = await zip(
      Array.from({ length: 100 }, (_, i) => [
        `src/file-${i}.php`,
        "<?php // example source\n".repeat(2000)
      ])
    );
    const started = performance.now();
    const built = await buildExtensionPackage(source, manifest);
    expect(built.sourceFileCount).toBe(100);
    expect(Object.keys(await contents(built.bytes))).toHaveLength(101);
    console.info(
      JSON.stringify({
        packageSpike: {
          sourceBytes: source.length,
          packageBytes: built.bytes.length,
          expandedBytes: built.expandedBytes,
          elapsedMs: Math.round(performance.now() - started)
        }
      })
    );
  });
});
