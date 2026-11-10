import { HttpPackageProcessor } from "@fossbilling/extension-packaging/adapters/http";
import { PackageError } from "@fossbilling/extension-packaging/errors";

export function configuredPackageProcessor(
  getEnv: (name: string) => string | undefined
) {
  const url = getEnv("EXTENSION_PACKAGER_URL");
  const secret = getEnv("EXTENSION_PACKAGER_SECRET");
  if (!url || !secret)
    throw new PackageError(
      "PACKAGES_DISABLED",
      "Package processor is not configured",
      503
    );
  return new HttpPackageProcessor(
    url,
    secret,
    getEnv("ENVIRONMENT") !== "production"
  );
}
