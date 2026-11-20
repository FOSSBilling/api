import { createCloudflareBindings } from "./index";
import { PackageBuildDatabase } from "../../../services/extensions/v2/db/package-builds";
import type { PackagePreparation } from "../../../services/extensions/v2/packages/prepare";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import { configuredPackageStore } from "../../../services/extensions/v2/packages/store";
import { configuredPackageProcessor } from "../../../services/extensions/v2/packages/processor";

export function packagePreparation(
  env: CloudflareBindings
): PackagePreparation {
  const bindings = createCloudflareBindings(env);
  const getEnv = (name: string) => bindings.environment.get(name);
  const store = configuredPackageStore(getEnv);
  const baseUrl = getEnv("EXTENSION_PACKAGES_BASE_URL");
  if (!store || !baseUrl)
    throw new PackageError(
      "PACKAGES_DISABLED",
      "Package storage or download URL is not configured",
      503
    );
  return {
    repository: new PackageBuildDatabase(env.DB_EXTENSIONS),
    store,
    processor: configuredPackageProcessor(getEnv),
    baseUrl
  };
}
