import { downloadGitHubReleaseAsset } from "./github-release";
import { validateExtensionPackage } from "./zip";
import { PACKAGE_LIMITS } from "./limits";
import { sha256 } from "./checksum";
import { PackageError } from "./errors";
import type { PackageImageProcessor } from "./images";
import { boundedBytes, type PackageStore } from "./store";
import type { ProcessingInput, ProcessingResult } from "./processor";

export async function processPackage(
  input: ProcessingInput,
  store: PackageStore,
  images: PackageImageProcessor,
  {
    signal,
    githubAuthorization
  }: { signal: AbortSignal; githubAuthorization: string | null }
): Promise<ProcessingResult> {
  signal.throwIfAborted();
  const reference = input.source;
  const fromGitHub = "github" in reference;
  const source = fromGitHub
    ? await boundedBytes(
        await downloadGitHubReleaseAsset(
          reference,
          githubAuthorization,
          signal
        ),
        PACKAGE_LIMITS.sourceBytes
      )
    : await store.get(
        reference.id,
        reference.sha256,
        PACKAGE_LIMITS.sourceBytes
      );
  if (
    !source?.length ||
    (fromGitHub &&
      (source.length !== reference.github.bytes ||
        (await sha256(source)) !== reference.sha256))
  ) {
    if (fromGitHub)
      throw new PackageError(
        "INVALID_PACKAGE",
        "The GitHub asset no longer matches its recorded size and checksum",
        422
      );
    throw new PackageError(
      "SOURCE_UNAVAILABLE",
      "Source ZIP is unavailable",
      503
    );
  }
  let validated;
  try {
    validated = await validateExtensionPackage(source, signal);
  } catch (error) {
    signal.throwIfAborted();
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
  const icons = validated.icon
    ? await images.prepare(validated.icon, validated.iconName === "icon.svg")
    : [];
  signal.throwIfAborted();
  // Seal the validated bytes at a key that has never had a client PUT URL.
  await store.put(input.archive, source, reference.sha256);
  signal.throwIfAborted();
  return {
    manifest,
    archiveBytes: source.length,
    icons
  };
}
