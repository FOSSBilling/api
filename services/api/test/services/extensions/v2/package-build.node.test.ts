import { describe, expect, it, vi } from "vitest";
import {
  TextReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter
} from "@zip.js/zip.js";
import { type ProcessingInput } from "@fossbilling/extension-packaging/processor";
import { processPackage } from "@fossbilling/extension-packaging/process";
import { prepareQueuedPackage } from "../../../../src/services/extensions/v2/packages/prepare";
import type {
  PackageRepository,
  ArtifactRow,
  SourceRow,
  IconObject
} from "../../../../src/services/extensions/v2/packages/repository";
import type { PackagingJob } from "../../../../src/services/extensions/v2/packages/jobs";
import type { PackageStore } from "@fossbilling/extension-packaging/store";
import { sha256 } from "@fossbilling/extension-packaging/checksum";

const zipOptions = { useWebWorkers: false, useCompressionStream: true };
describe("package preparation outside Cloudflare", () => {
  it("prepares and corrects ZIPs with injected persistence, storage and image processing", async () => {
    const manifest = {
      manifest_version: 1 as const,
      type: "module" as const,
      id: "node-example",
      name: "Node Example",
      version: "1.0.0",
      description: "Prepared in Node",
      author: { name: "Developer" },
      license: "MIT",
      requires: { fossbilling: ">=0.8.0" }
    };
    const owner = {
      id: crypto.randomUUID(),
      profile_generation: crypto.randomUUID(),
      ownership_epoch: 1,
      owner_user_id: "owner"
    };
    const extensionId = "019a0000-0000-7000-8000-000000000001";
    let source: SourceRow | null = null;
    let icons: IconObject[] | null = null;
    const artifacts = new Map<string, ArtifactRow>();
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected cleanup in normal preparation");
    };
    const repository: PackageRepository = {
      getOwner: async () => owner,
      findSource: async () => source,
      findArtifact: async (_sourceId, hash) => artifacts.get(hash) ?? null,
      hasIcon: async () => icons !== null,
      reserveObject: async () => {},
      setObjectSize: async () => {},
      removeObject: async () => {},
      claimCleanup: unexpected,
      finishCleanup: unexpected,
      linkSource: async (_owner, _manifest, input) => (source ??= input),
      ensureDraft: async () => extensionId,
      linkIcon: async (_owner, _identifier, _sourceId, input) => {
        icons = input;
        return true;
      },
      linkArtifact: async (_owner, metadata, input) => {
        const svg = icons?.find((icon) => icon.format === "svg");
        const row: ArtifactRow = {
          id: input.id,
          source_id: input.sourceId,
          manifest: JSON.stringify(metadata),
          sha256: input.sha256,
          object_id: input.objectId,
          download_url: input.downloadUrl,
          published_at: null,
          created_at: new Date().toISOString(),
          extension_identifier: metadata.id,
          profile_generation: owner.profile_generation,
          version: metadata.version,
          icon_source_id: input.sourceId,
          svg_object_id: svg?.id ?? null,
          svg_sha256: svg?.checksum ?? null,
          avif_object_id: null,
          avif_sha256: null,
          png_object_id: null,
          png_sha256: null
        };
        artifacts.set(input.manifestHash, row);
        return row;
      }
    };
    const objects = new Map<string, Uint8Array<ArrayBuffer>>();
    const store: PackageStore = {
      put: async (key, bytes) => {
        objects.set(key, new Uint8Array(bytes));
      },
      get: async (key) =>
        objects.has(key) ? new Blob([objects.get(key)!]).stream() : null,
      delete: async (key) => {
        objects.delete(key);
      }
    };
    const images = {
      prepare: vi.fn(async (bytes: Uint8Array<ArrayBuffer>) => [
        { format: "svg" as const, bytes }
      ])
    };
    const writer = new ZipWriter(new Uint8ArrayWriter(), zipOptions);
    await writer.add(
      "Service.php",
      new TextReader("<?php // Ready to install")
    );
    await writer.add(
      "icon.svg",
      new TextReader(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
      )
    );
    const upload = await writer.close();
    const uploadId = crypto.randomUUID();
    objects.set(uploadId, upload);
    const job: PackagingJob = {
      id: crypto.randomUUID(),
      fingerprint: "node",
      owner,
      manifest,
      sourceId: null,
      uploadObjectId: uploadId,
      uploadSha256: await sha256(upload),
      status: "processing",
      attempts: 1,
      artifactId: null,
      error: null,
      createdAt: "now",
      updatedAt: "now"
    };
    const services = {
      repository,
      store,
      processor: {
        process: (input: ProcessingInput) =>
          processPackage(input, store, images)
      },
      baseUrl: "https://directory.example.test/extensions/v2"
    };
    const id = await prepareQueuedPackage(services, job);
    const first = [...artifacts.values()].find((row) => row.id === id)!;
    const bytes = objects.get(first.object_id)!;
    expect(await sha256(bytes)).toBe(first.sha256);
    const reader = new ZipReader(new Uint8ArrayReader(bytes), zipOptions);
    try {
      const files: Record<string, string> = {};
      for (const entry of await reader.getEntries()) {
        if (!entry.directory)
          files[entry.filename] = await entry.getData!(new TextWriter());
      }
      expect(JSON.parse(files["manifest.json"])).toEqual(manifest);
      expect(files["Service.php"]).toBe("<?php // Ready to install");
    } finally {
      await reader.close();
    }
    expect(first.svg_object_id).toMatch(
      new RegExp(`^extensions/${extensionId}/icons/`)
    );
    const correctedId = await prepareQueuedPackage(services, {
      ...job,
      manifest: { ...manifest, description: "Corrected in Node" },
      sourceId: first.source_id,
      uploadObjectId: null,
      uploadSha256: null
    });
    const corrected = [...artifacts.values()].find(
      (row) => row.id === correctedId
    )!;
    expect(corrected.source_id).toBe(first.source_id);
    expect(corrected.svg_object_id).toBe(first.svg_object_id);
    expect(corrected.sha256).not.toBe(first.sha256);
    expect(images.prepare).toHaveBeenCalledOnce();
  });
});
