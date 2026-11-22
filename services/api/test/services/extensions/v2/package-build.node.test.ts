import { describe, expect, it } from "vitest";
import { type ProcessingInput } from "@fossbilling/extension-packaging/processor";
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

describe("package preparation outside Cloudflare", () => {
  it("records a prepared package with injected persistence, storage and processing", async () => {
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
      isPublishedVersion: async () => false,
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
        artifacts.set(input.sha256, row);
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
    const icon = new Uint8Array(
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
      )
    );
    const upload = new Uint8Array([1, 2, 3]);
    const checksum = await sha256(upload);
    const uploadId = crypto.randomUUID();
    const job: PackagingJob = {
      id: crypto.randomUUID(),
      fingerprint: "node",
      owner,
      target: {},
      uploadObjectId: uploadId,
      uploadSha256: checksum,
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
        process: async (input: ProcessingInput) => {
          expect(input.source).toEqual({ id: uploadId, sha256: checksum });
          const iconChecksum = await sha256(icon);
          await store.put(input.icons[0], icon, iconChecksum);
          return {
            manifest,
            archive: { bytes: upload.length, sha256: checksum },
            icons: [
              {
                id: input.icons[0],
                format: "svg" as const,
                bytes: icon.length,
                sha256: iconChecksum
              }
            ]
          };
        }
      },
      baseUrl: "https://directory.example.test/extensions/v2"
    };
    const id = await prepareQueuedPackage(services, job);
    const first = [...artifacts.values()].find((row) => row.id === id)!;
    expect(first.object_id).not.toBe(uploadId);
    expect(JSON.parse(first.manifest)).toEqual(manifest);
    expect(first.svg_object_id).toMatch(
      new RegExp(`^extensions/${extensionId}/icons/`)
    );
  });
});
