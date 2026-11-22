import { sanitizeSvg } from "@zeropress/svg-hush/workerd";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import type {
  IconVariant,
  PackageImageProcessor
} from "@fossbilling/extension-packaging/images";
import { boundedBytes } from "@fossbilling/extension-packaging/store";

function invalidIcon() {
  return new PackageError(
    "INVALID_ICON",
    "Package icon could not be processed",
    422
  );
}

function prepareSvg(icon: Uint8Array<ArrayBuffer>): IconVariant[] {
  try {
    return [{ format: "svg", bytes: new Uint8Array(sanitizeSvg(icon)) }];
  } catch {
    throw invalidIcon();
  }
}

export class CloudflarePackageImages implements PackageImageProcessor {
  constructor(private readonly images: ImagesBinding) {}

  async prepare(
    icon: Uint8Array<ArrayBuffer>,
    isSvg: boolean
  ): Promise<IconVariant[]> {
    if (isSvg) return prepareSvg(icon);

    const input = new Blob([icon]);
    try {
      const info = await this.images.info(input.stream());
      if (info.format === "image/svg+xml") return prepareSvg(icon);
      if (!("width" in info) || info.width * info.height > 16 * 1024 * 1024)
        throw invalidIcon();

      const variants: IconVariant[] = [];
      for (const format of ["avif", "png"] as const) {
        const mime = `image/${format}` as const;
        const output = await this.images
          .input(input.stream())
          .transform({ width: 256, height: 256, fit: "scale-down" })
          .output({ format: mime, anim: false });
        const response = output.response();
        const bytes = await boundedBytes(response.body, 1024 * 1024);
        if (!bytes.length || response.headers.get("Content-Type") !== mime)
          throw invalidIcon();
        variants.push({ format, bytes });
      }
      return variants;
    } catch (error) {
      if (error instanceof PackageError) {
        if (error.status === 413) throw invalidIcon();
        throw error;
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        [9412, 9413, 9520, 9523].includes(Number(error.code))
      )
        throw invalidIcon();
      throw new PackageError(
        "PACKAGE_UNAVAILABLE",
        "Image processing is temporarily unavailable",
        503
      );
    }
  }
}
