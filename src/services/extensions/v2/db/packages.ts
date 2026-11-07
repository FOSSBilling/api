import { latestRelease } from "../../../../lib/releases";
import { ExtensionContent } from "../schemas/extensions";
import { ManifestSchema } from "../schemas/manifest";
import type { DatabaseError } from "../../../../lib/interfaces";

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

export interface ArtifactRow {
  id: string;
  source_id: string;
  manifest: string;
  sha256: string;
  object_id: string;
  download_url: string;
  published_at: string | null;
  created_at: string;
  extension_id: string;
  profile_generation: string;
  version: string;
  icon_source_id: string | null;
  avif_object_id: string | null;
  avif_sha256: string | null;
  png_object_id: string | null;
  png_sha256: string | null;
  svg_object_id: string | null;
  svg_sha256: string | null;
}

export const ARTIFACT_SELECT = `SELECT a.*, s.extension_id, s.profile_generation, s.version, i.source_id AS icon_source_id, i.avif_object_id, i.avif_sha256, i.png_object_id, i.png_sha256, i.svg_object_id, i.svg_sha256
  FROM package_artifacts a JOIN package_sources s ON s.id=a.source_id LEFT JOIN package_icons i ON i.source_id=s.id`;

// All submission, publisher, correction and approval writers use this check.
export async function validatePackageContent(
  db: D1Database,
  id: string,
  developerId: string | undefined,
  content: ExtensionContent,
  callerId?: string
): Promise<DatabaseError | null> {
  id = id.toLowerCase();
  if (!developerId) {
    const ref = await db
      .prepare(
        `SELECT d.id FROM extensions e JOIN developers d ON d.id=e.developer_id WHERE lower(e.id)=lower(?) AND (? IS NULL OR d.owner_user_id=?)`
      )
      .bind(id, callerId ?? null, callerId ?? null)
      .first<{ id: string }>();
    if (!ref) return null;
    developerId = ref.id;
  }
  const published = await db
    .prepare(
      `SELECT DISTINCT s.version FROM package_artifacts a JOIN package_sources s ON s.id=a.source_id WHERE s.extension_id=? AND a.published_at IS NOT NULL`
    )
    .bind(id)
    .all<{ version: string }>();
  const publishedVersions = new Set(
    published.results.map((row) => row.version)
  );
  const managed = publishedVersions.size > 0;
  const hasArtifacts = content.releases.some((r) => r.artifact_id);
  const selectedCount = content.releases.filter(
    (r) => r.is_latest === true
  ).length;
  const fail = (message: string): DatabaseError => ({
    code: "CONFLICT",
    message
  });
  if (selectedCount > 1) return fail("Select only one latest release");
  if (
    !managed &&
    !hasArtifacts &&
    !selectedCount &&
    !content.releases.some((r) => r.sha256)
  )
    return null;
  const latest = latestRelease(content.releases);
  if (
    !latest ||
    latest.tag.replace(/^v/, "") !== content.version ||
    latest.download_url !== content.download_url ||
    canonicalJson(latest.requires) !== canonicalJson(content.requires)
  )
    return fail(
      "Version, download and requirements must match the selected latest release"
    );
  if ((managed || hasArtifacts) && !latest.artifact_id)
    return fail(
      "The latest release needs a directory-built package; upload its source ZIP first"
    );
  const artifactIds = [
    ...new Set(
      content.releases.flatMap((release) =>
        release.artifact_id ? [release.artifact_id] : []
      )
    )
  ];
  const rows = await db
    .prepare(
      `${ARTIFACT_SELECT} JOIN developers d ON d.profile_generation=s.profile_generation WHERE a.id IN (SELECT value FROM json_each(?)) AND s.extension_id=? AND d.id=?`
    )
    .bind(JSON.stringify(artifactIds), id, developerId)
    .all<ArtifactRow>();
  const artifacts = new Map(rows.results.map((row) => [row.id, row]));
  const versions = new Set<string>();
  for (const release of content.releases) {
    const version = release.tag.replace(/^v/, "");
    if ((managed || hasArtifacts) && versions.has(version))
      return fail("Duplicate release version");
    versions.add(version);
    if (!release.artifact_id) {
      if (release.sha256)
        return fail("Checksums require a directory-built artifact");
      if (publishedVersions.has(version))
        return fail(
          "A directory-built release cannot be replaced with an external download"
        );
      continue;
    }
    const artifact = artifacts.get(release.artifact_id);
    if (
      !artifact ||
      artifact.version !== version ||
      artifact.download_url !== release.download_url ||
      artifact.sha256 !== release.sha256
    )
      return fail("Release does not match its package artifact");
    const manifest = ManifestSchema.parse(JSON.parse(artifact.manifest));
    if (canonicalJson(manifest.requires) !== canonicalJson(release.requires))
      return fail("Release requirements do not match its package manifest");
    if (
      release === latest &&
      (content.download_url !== artifact.download_url ||
        canonicalJson(manifest) !== canonicalJson(contentManifest(id, content)))
    )
      return fail(
        "Overview metadata must match the latest package manifest; rebuild it before submitting"
      );
  }
  return null;
}

export function packageIconUrl(content: ExtensionContent): string | null {
  return latestRelease(content.releases)?.artifact_id
    ? content.download_url.replace(/\/download$/, "/icon")
    : null;
}
