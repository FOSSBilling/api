import { logError } from "@fossbilling/logging";
import {
  ProcessingResultSchema,
  type PackageProcessor,
  type ProcessingInput
} from "../processor";
import { PackageError } from "../errors";
import { boundedBytes } from "../store";

export class HttpPackageProcessor implements PackageProcessor {
  private readonly url: URL;
  constructor(
    url: string,
    private readonly secret: string,
    local = false
  ) {
    this.url = new URL(url);
    if (
      !secret ||
      this.url.username ||
      this.url.password ||
      this.url.hash ||
      !(
        this.url.protocol === "https:" ||
        (local &&
          this.url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(this.url.hostname))
      )
    )
      throw new PackageError(
        "PACKAGES_DISABLED",
        "Package processor is not configured correctly",
        503
      );
  }
  async process(input: ProcessingInput) {
    try {
      const response = await fetch(
        new Request(this.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.secret}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(input),
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(50000)
        })
      );
      const bytes = await boundedBytes(response.body, 16 * 1024);
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (response.status === 422 && typeof body.error?.message === "string")
        throw new PackageError(
          body.error.code === "INVALID_ICON"
            ? "INVALID_ICON"
            : "INVALID_PACKAGE",
          body.error.message.slice(0, 1000),
          422
        );
      if (!response.ok) throw new Error("Package processor request failed");
      const result = ProcessingResultSchema.parse(body.result);
      const allowed: readonly string[] = input.icons ?? [];
      if (
        result.icons.some((icon) => !allowed.includes(icon.id)) ||
        new Set(result.icons.map((icon) => icon.id)).size !==
          result.icons.length
      )
        throw new Error("Package processor returned unexpected output IDs");
      return result;
    } catch (error) {
      if (error instanceof PackageError && error.status === 422) throw error;
      logError("extensions/packages", "Package processor request failed", {
        objectId: input.archive,
        error: error instanceof Error ? error.message : "Unknown error"
      });
      throw new PackageError(
        "PACKAGE_UNAVAILABLE",
        "Package processor is temporarily unavailable. Please try again.",
        503
      );
    }
  }
}
