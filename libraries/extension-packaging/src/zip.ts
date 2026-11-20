import { PACKAGE_LIMITS } from "./limits";
import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { ManifestSchema } from "./manifest";

const zipOptions = {
  useWebWorkers: false,
  useCompressionStream: true,
  strictness: "strict" as const,
  checkCrc32: true,
  checkOverlappingEntry: true
};

function validatePath(filename: string, directory: boolean) {
  const path = directory ? filename.replace(/\/$/, "") : filename;
  if (path.length > PACKAGE_LIMITS.pathLength)
    throw new Error("Package path exceeds length limit");
  const parts = path.split("/");
  if (parts.length > PACKAGE_LIMITS.pathDepth)
    throw new Error("Package path exceeds depth limit");
  if (
    !path ||
    /[\\:<>"|?*]/.test(path) ||
    [...path].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    ) ||
    parts.some((part) => !part || part === "." || part === "..") ||
    parts.some(
      (part) =>
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
  ) {
    throw new Error(`Unsafe package path: ${filename}`);
  }
  return path;
}

/** Validate the uploaded archive and read its listing metadata. */
export async function validateExtensionPackage(
  source: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal
) {
  if (source.byteLength > PACKAGE_LIMITS.sourceBytes) {
    throw new Error("Source ZIP exceeds size limit");
  }
  if (
    source.length < 4 ||
    new DataView(source.buffer, source.byteOffset, 4).getUint32(0, true) !==
      0x04034b50
  )
    throw new Error("Expected a ZIP without a prepended payload");
  const reader = new ZipReader(new Uint8ArrayReader(source), {
    ...zipOptions,
    signal
  });
  let manifestBytes: Uint8Array<ArrayBuffer> | undefined;
  let icon: Uint8Array<ArrayBuffer> | undefined;
  let iconName: string | undefined;
  let files = 0;
  const paths = new Map<string, boolean>();
  let count = 0;
  let expandedBytes = 0;
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (++count > PACKAGE_LIMITS.entries) {
        throw new Error("Source ZIP exceeds entry limit");
      }
      const path = validatePath(entry.filename, entry.directory);
      // Avoid case-folding collisions across supported installation platforms.
      const key = path.normalize("NFC").toLowerCase();
      if (key.startsWith("manifest.json/")) {
        throw new Error("Manifest path is a directory");
      }
      if (paths.has(key)) throw new Error(`Duplicate package path: ${path}`);
      paths.set(key, entry.directory);
      const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (
        entry.encrypted ||
        entry.symlink ||
        entry.setuid ||
        entry.setgid ||
        (entry.directory &&
          (!entry.filename.endsWith("/") || entry.uncompressedSize !== 0)) ||
        (fileType !== 0 &&
          fileType !== (entry.directory ? 0o040000 : 0o100000)) ||
        ![0, 8].includes(entry.compressionMethod)
      ) {
        throw new Error(`Unsupported package entry: ${path}`);
      }
      if (
        entry.uncompressedSize >
        PACKAGE_LIMITS.expandedBytes - expandedBytes
      ) {
        throw new Error("Source ZIP exceeds expanded size limit");
      }
      // Bound the actual decompressed bytes, not just the untrusted ZIP header.
      const isIcon =
        !entry.directory && /^icon\.(svg|png|webp|avif)$/.test(path);
      const isManifest = path === "manifest.json";
      if (key === "manifest.json" && !isManifest)
        throw new Error("Manifest must be named manifest.json");
      if (
        isManifest &&
        (entry.directory ||
          entry.uncompressedSize > PACKAGE_LIMITS.manifestBytes)
      )
        throw new Error("Expected a root manifest.json file up to 256 KiB");
      if (isIcon && icon) throw new Error("Include only one package icon");
      const chunks: Uint8Array[] = [];
      let length = 0;
      // zip.js also exposes getData on directories at runtime.
      if (!("getData" in entry))
        throw new Error("Unable to validate ZIP entry");
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            expandedBytes += chunk.byteLength;
            length += chunk.byteLength;
            if (expandedBytes > PACKAGE_LIMITS.expandedBytes) {
              throw new Error("Source ZIP exceeds expanded size limit");
            }
            if (isManifest && length > PACKAGE_LIMITS.manifestBytes)
              throw new Error("Manifest exceeds size limit");
            if (entry.directory && length)
              throw new Error("ZIP directory entry contains data");
            if (isIcon || isManifest) chunks.push(chunk.slice());
          }
        })
      );
      if (length !== entry.uncompressedSize) {
        throw new Error("Source ZIP entry has inconsistent size");
      }
      if (!isManifest && !entry.directory) files++;
      if (isManifest || isIcon) {
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (isManifest) {
          manifestBytes = bytes;
        } else {
          icon = bytes;
          iconName = path;
        }
      }
    }
  } finally {
    await reader.close();
  }
  for (const [path] of paths) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (paths.get(parts.join("/")) === false) {
        throw new Error(`File conflicts with package directory: ${path}`);
      }
      parts.pop();
    }
  }
  if (!manifestBytes)
    throw new Error("Package must contain a root manifest.json");
  if (!files) throw new Error("Package contains no source files");
  const manifestText = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true
  }).decode(manifestBytes);
  if (manifestText.startsWith("\uFEFF")) {
    throw new Error("manifest.json must be UTF-8 without a byte order mark");
  }
  // Skip valid pairs and escaped backslashes. Check the original text because
  // JSON.parse discards overwritten values before calling the reviver.
  for (const [, unpaired] of manifestText.matchAll(
    /\\ud[89ab][\da-f]{2}\\ud[c-f][\da-f]{2}|(\\ud[89a-f][\da-f]{2})|\\./gi
  )) {
    if (unpaired) {
      throw new Error(
        "manifest.json contains an unpaired Unicode surrogate escape"
      );
    }
  }
  const parsed = JSON.parse(
    manifestText,
    (key, value: unknown, context?: { source?: string }) => {
      // PHP's installer requires an integer and rejects decimal or exponent forms.
      if (
        key === "manifest_version" &&
        value === 1 &&
        context?.source !== "1"
      ) {
        throw new Error("manifest_version must be written as the integer 1");
      }
      return value;
    }
  );
  const manifest = ManifestSchema.parse(parsed);
  return { manifest, icon, iconName };
}
