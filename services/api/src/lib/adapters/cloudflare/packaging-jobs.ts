import { createCloudflareBindings } from "./index";
import { PackageBuildDatabase } from "../../../services/extensions/v2/db/package-builds";
import type { PackagePreparation } from "../../../services/extensions/v2/packages/prepare";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import { configuredPackageStore } from "../../../services/extensions/v2/packages/store";
import { b2ObjectStore } from "@fossbilling/extension-packaging/adapters/b2";
import { processPackage } from "@fossbilling/extension-packaging/process";
import { publicGitHubToken } from "../../github-app";
import { CloudflarePackageImages } from "./package-images";

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
  const images = new CloudflarePackageImages(env.PACKAGE_IMAGES);
  return {
    repository: new PackageBuildDatabase(env.DB_EXTENSIONS),
    store,
    processor: {
      async process(input) {
        const signal = AbortSignal.timeout(45_000);
        const githubAuthorization =
          "github" in input.source
            ? `Bearer ${await publicGitHubToken({ getEnv })}`
            : null;
        return processPackage(
          input,
          b2ObjectStore(getEnv, "packages", signal),
          images,
          { signal, githubAuthorization }
        );
      }
    },
    baseUrl
  };
}
