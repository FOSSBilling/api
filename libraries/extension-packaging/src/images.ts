export interface IconVariant {
  format: "avif" | "png" | "svg";
  bytes: Uint8Array<ArrayBuffer>;
}
export interface PackageImageProcessor {
  prepare(
    icon: Uint8Array<ArrayBuffer>,
    isSvg: boolean
  ): Promise<IconVariant[]>;
}
