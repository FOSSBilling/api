import { downloadGitHubReleaseAsset } from "./github-release";
import { validateExtensionPackage } from "./zip";
import { PACKAGE_LIMITS } from "@fossbilling/extension-packaging/limits";
import { sha256 } from "@fossbilling/extension-packaging/checksum";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import type { PackageImageProcessor } from "@fossbilling/extension-packaging/images";
import {
  boundedBytes,
  type PackageStore
} from "@fossbilling/extension-packaging/store";
import {
  ProcessingResultSchema,
  type ProcessingInput,
  type ProcessingResult
} from "@fossbilling/extension-packaging/processor";

export async function processPackage(
  input: ProcessingInput,
  store: PackageStore,
  images: PackageImageProcessor,
  signal?: AbortSignal
): Promise<ProcessingResult> {
  signal?.throwIfAborted();
  const reference = input.source;
  const fromGitHub = "github" in reference;
  const source = await boundedBytes(
    fromGitHub
      ? await downloadGitHubReleaseAsset(reference, signal)
      : await store.get(reference.id, reference.sha256),
    PACKAGE_LIMITS.sourceBytes
  );
  if (
    !source.length ||
    (fromGitHub && source.length !== reference.github.bytes) ||
    (await sha256(source)) !== reference.sha256
  ) {
    if (fromGitHub)
      throw new PackageError(
        "INVALID_PACKAGE",
        "The GitHub asset no longer matches its recorded size and checksum",
        422
      );
    throw new PackageError(
      "SOURCE_UNAVAILABLE",
      "Source ZIP is unavailable or failed checksum verification",
      503
    );
  }
  let validated;
  try {
    validated = await validateExtensionPackage(source, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new PackageError(
      "INVALID_PACKAGE",
      error instanceof Error
        ? error.message
        : "Source ZIP failed package validation",
      422
    );
  }
  const { manifest } = validated;
  if (
    (input.target.id && input.target.id !== manifest.id) ||
    (input.target.version && input.target.version !== manifest.version)
  )
    throw new PackageError(
      "INVALID_PACKAGE",
      "ZIP manifest does not match the expected extension or release version",
      422
    );
  const variants = validated.icon
    ? await images.prepare(validated.icon, validated.iconName === "icon.svg")
    : [];
  signal?.throwIfAborted();
  // Seal the validated bytes at a key that has never had a client PUT URL.
  await store.put(input.archive, source, reference.sha256);
  const icons: ProcessingResult["icons"] = [];
  for (const [index, variant] of variants.entries()) {
    signal?.throwIfAborted();
    const id = input.icons[index];
    const checksum = await sha256(variant.bytes);
    await store.put(id, variant.bytes, checksum);
    icons.push({
      id,
      format: variant.format,
      sha256: checksum,
      bytes: variant.bytes.length
    });
  }
  signal?.throwIfAborted();
  return ProcessingResultSchema.parse({
    manifest,
    archive: { bytes: source.length, sha256: reference.sha256 },
    icons
  });
}
