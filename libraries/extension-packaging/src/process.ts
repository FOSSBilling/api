import { buildExtensionPackage } from "./zip";
import { PACKAGE_LIMITS } from "./limits";
import { sha256 } from "./checksum";
import { PackageError } from "./errors";
import type { PackageImageProcessor } from "./images";
import { boundedBytes, type PackageStore } from "./store";
import {
  ProcessingResultSchema,
  type ProcessingInput,
  type ProcessingResult
} from "./processor";

export async function processPackage(
  input: ProcessingInput,
  store: PackageStore,
  images: PackageImageProcessor,
  signal?: AbortSignal
): Promise<ProcessingResult> {
  signal?.throwIfAborted();
  const source = await boundedBytes(
    await store.get(input.source.id, input.source.sha256),
    PACKAGE_LIMITS.sourceBytes
  );
  if (!source.length || (await sha256(source)) !== input.source.sha256)
    throw new PackageError(
      "SOURCE_UNAVAILABLE",
      "Source ZIP is unavailable or failed checksum verification",
      503
    );
  let built;
  try {
    built = await buildExtensionPackage(source, input.manifest, signal);
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
  const variants =
    input.icons && built.icon
      ? await images.prepare(built.icon, built.iconName === "icon.svg")
      : [];
  signal?.throwIfAborted();
  await store.put(input.archive, built.bytes, built.packageSha256);
  const icons: ProcessingResult["icons"] = [];
  for (const [index, variant] of variants.entries()) {
    signal?.throwIfAborted();
    const id = input.icons![index];
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
    archive: { bytes: built.bytes.length, sha256: built.packageSha256 },
    icons
  });
}
