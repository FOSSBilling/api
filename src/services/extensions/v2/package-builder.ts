import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter
} from "@zip.js/zip.js";
import { ManifestSchema } from "./schemas/manifest";

// Bounds for uploaded ZIPs and their decompressed contents.
export const PACKAGE_LIMITS = {
  sourceBytes: 5 * 1024 * 1024,
  expandedBytes: 16 * 1024 * 1024,
  entries: 500,
  pathLength: 1024,
  pathDepth: 32
} as const;

const zipOptions = {
  useWebWorkers: false,
  useCompressionStream: true,
  strictness: "strict" as const,
  checkCrc32: true,
  checkOverlappingEntry: true
};

export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

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

/** Validate source files and build a bounded archive with directory metadata. */
export async function buildExtensionPackage(
  source: Uint8Array<ArrayBuffer>,
  manifestInput: unknown
) {
  const manifest = ManifestSchema.parse(manifestInput);
  if (source.byteLength > PACKAGE_LIMITS.sourceBytes) {
    throw new Error("Source ZIP exceeds size limit");
  }
  const reader = new ZipReader(new Uint8ArrayReader(source), zipOptions);
  const files: {
    path: string;
    bytes: Uint8Array<ArrayBuffer>;
    compression?: {
      passThrough: true;
      compressionMethod: number;
      uncompressedSize: number;
      crc32?: number;
    };
    icon?: Uint8Array<ArrayBuffer>;
  }[] = [];
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
      if (entry.directory) continue;
      // Bound the actual decompressed bytes, not just the untrusted ZIP header.
      const isIcon = /^icon\.(svg|png|webp|avif)$/.test(path);
      const chunks: Uint8Array[] = [];
      let length = 0;
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            expandedBytes += chunk.byteLength;
            length += chunk.byteLength;
            if (expandedBytes > PACKAGE_LIMITS.expandedBytes) {
              throw new Error("Source ZIP exceeds expanded size limit");
            }
            if (isIcon) chunks.push(chunk.slice());
          }
        })
      );
      if (length !== entry.uncompressedSize) {
        throw new Error("Source ZIP entry has inconsistent size");
      }
      const icon = isIcon ? new Uint8Array(length) : undefined;
      let offset = 0;
      for (const chunk of chunks) {
        icon!.set(chunk, offset);
        offset += chunk.byteLength;
      }
      // Validate the existing manifest's ZIP entry too, then replace its bytes.
      if (key === "manifest.json") {
        if (path !== "manifest.json") {
          throw new Error("Manifest must be named manifest.json");
        }
      } else {
        // CRC and expanded-size validation above still decompresses every file.
        // Copy its original compressed payload instead of compressing it again.
        const bytes = await entry.getData(new Uint8ArrayWriter(), {
          passThrough: true
        });
        files.push({
          path,
          bytes,
          icon,
          compression: {
            passThrough: true,
            compressionMethod: entry.compressionMethod,
            uncompressedSize: entry.uncompressedSize,
            crc32: entry.signature
          }
        });
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
  if (paths.get("manifest.json") === true) {
    throw new Error("Manifest path is a directory");
  }
  if (!files.length) throw new Error("Package contains no source files");
  const icons = files.filter((file) =>
    /^icon\.(svg|png|webp|avif)$/.test(file.path)
  );
  if (icons.length > 1) throw new Error("Include only one package icon");

  const manifestBytes = new Uint8Array(
    new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n")
  );
  files.push({ path: "manifest.json", bytes: manifestBytes });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    ...zipOptions,
    level: 6,
    lastModDate: new Date("1980-01-01T00:00:00Z"),
    extendedTimestamp: false
  });
  for (const file of files) {
    await writer.add(
      file.path,
      new Uint8ArrayReader(file.bytes),
      file.compression
    );
  }
  const bytes = await writer.close();
  return {
    bytes,
    manifest,
    sourceSha256: await sha256(source),
    packageSha256: await sha256(bytes),
    sourceFileCount: files.length - 1,
    expandedBytes,
    icon: icons[0]?.icon ?? null,
    iconName: icons[0]?.path
  };
}
