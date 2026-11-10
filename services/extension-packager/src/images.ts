import sharp from "sharp";
import { sanitizeSvg } from "@zeropress/svg-hush/node";
import type {
  PackageImageProcessor,
  IconVariant
} from "@fossbilling/extension-packaging/images";
import { PackageError } from "@fossbilling/extension-packaging/errors";

export class NodePackageImages implements PackageImageProcessor {
  async prepare(
    icon: Uint8Array<ArrayBuffer>,
    isSvg: boolean
  ): Promise<IconVariant[]> {
    try {
      if (
        isSvg ||
        (await sharp(icon, { limitInputPixels: 16 * 1024 * 1024 }).metadata())
          .format === "svg"
      )
        return [{ format: "svg", bytes: new Uint8Array(sanitizeSvg(icon)) }];
      const variants: IconVariant[] = [];
      for (const format of ["avif", "png"] as const) {
        const bytes = new Uint8Array(
          await sharp(icon, { limitInputPixels: 16 * 1024 * 1024 })
            .rotate()
            .resize({
              width: 256,
              height: 256,
              fit: "inside",
              withoutEnlargement: true
            })
            .toFormat(format)
            .timeout({ seconds: 10 })
            .toBuffer()
        );
        if (bytes.length > 1024 * 1024)
          throw new Error("Prepared icon exceeds size limit");
        variants.push({ format, bytes });
      }
      return variants;
    } catch {
      throw new PackageError(
        "INVALID_ICON",
        "Package icon could not be processed",
        422
      );
    }
  }
}
