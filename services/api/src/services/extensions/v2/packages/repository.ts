import type { Manifest } from "../schemas/manifest";

export interface PackageOwner {
  id: string;
  profile_generation: string;
  ownership_epoch: number;
  owner_user_id: string;
  publisher_client_id?: string;
}
export interface SourceRow {
  id: string;
  sha256: string;
  object_id: string;
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
  extension_identifier: string;
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

export interface PackagePublisher {
  clientId: string;
  developerId: string;
  ownershipEpoch: number;
}
export interface IconObject {
  format: "svg" | "avif" | "png";
  id: string;
  checksum: string;
}
export interface PackageRepository {
  getOwner(
    userId: string,
    identifier: string,
    publisher?: PackagePublisher | null
  ): Promise<PackageOwner>;
  findSource(
    generation: string,
    identifier: string,
    version: string
  ): Promise<SourceRow | null>;
  findArtifact(
    sourceId: string,
    manifestHash: string
  ): Promise<ArtifactRow | null>;
  hasIcon(sourceId: string): Promise<boolean>;
  reserveObject(
    owner: PackageOwner,
    identifier: string,
    id: string,
    bytes: number
  ): Promise<void>;
  setObjectSize(id: string, bytes: number): Promise<void>;
  removeObject(id: string): Promise<void>;
  claimCleanup(): Promise<string[]>;
  finishCleanup(id: string): Promise<void>;
  linkSource(
    owner: PackageOwner,
    manifest: Manifest,
    source: SourceRow
  ): Promise<SourceRow | null>;
  ensureDraft(owner: PackageOwner, identifier: string): Promise<string>;
  linkArtifact(
    owner: PackageOwner,
    manifest: Manifest,
    artifact: {
      id: string;
      sourceId: string;
      manifestHash: string;
      sha256: string;
      objectId: string;
      downloadUrl: string;
    }
  ): Promise<ArtifactRow | null>;
  linkIcon(
    owner: PackageOwner,
    identifier: string,
    sourceId: string,
    objects: IconObject[]
  ): Promise<boolean>;
}
