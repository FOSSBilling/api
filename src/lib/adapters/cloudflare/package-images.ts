import { sanitizeSvg } from "@zeropress/svg-hush/workerd";
import type {
  PackageImageProcessor,
  IconVariant
} from "../../../services/extensions/v2/packages/images";
import { PackageError } from "../../../services/extensions/v2/packages/errors";
import { boundedBytes } from "../../../services/extensions/v2/packages/store";

export class CloudflarePackageImages implements PackageImageProcessor {
  constructor(private readonly images?: ImagesBinding) {}
  async prepare(
    icon: Uint8Array<ArrayBuffer>,
    isSvg: boolean
  ): Promise<IconVariant[]> {
    const images = this.images;
    if (isSvg) {
      try {
        return [{ format: "svg", bytes: new Uint8Array(sanitizeSvg(icon)) }];
      } catch {
        throw new PackageError(
          "INVALID_ICON",
          "Package SVG icon could not be sanitized",
          422
        );
      }
    }
    if (!images)
      throw new PackageError(
        "PACKAGES_DISABLED",
        "Image processing is not configured",
        503
      );
    const variants: IconVariant[] = [];
    try {
      const info = await images.info(new Blob([icon]).stream());
      // Check decoded format too: a misleading filename must not bypass sanitization.
      if (info.format === "image/svg+xml")
        return [{ format: "svg", bytes: new Uint8Array(sanitizeSvg(icon)) }];
      for (const format of ["avif", "png"] as const) {
        const output = await images
          .input(new Blob([icon]).stream())
          .transform({
            width: 256,
            height: 256,
            fit: "scale-down"
          })
          .output({ format: `image/${format}`, anim: false });
        variants.push({
          format,
          bytes: await boundedBytes(output.image(), 1024 * 1024)
        });
      }
    } catch {
      throw new PackageError(
        "INVALID_ICON",
        "Package icon could not be processed",
        422
      );
    }
    return variants;
  }
}
