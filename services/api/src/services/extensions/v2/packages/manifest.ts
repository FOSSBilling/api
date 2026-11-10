import type { ExtensionContent } from "../schemas/extensions";
import { ManifestSchema } from "../schemas/manifest";

// Sort nested maps too: object key ordering does not change a manifest.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function contentManifest(id: string, content: ExtensionContent) {
  return ManifestSchema.parse({
    id,
    manifest_version: content.manifest_version,
    type: content.type,
    name: content.name,
    version: content.version,
    description: content.description,
    author: content.author,
    license: content.license,
    homepage_url: content.homepage_url,
    requires: content.requires
  });
}
