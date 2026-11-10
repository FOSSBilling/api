import { v7 as uuidv7 } from "uuid";
import { ARTIFACT_SELECT } from "./packages";
import { canonicalJson } from "../packages/manifest";
import type { Manifest } from "../schemas/manifest";
import type {
  PackageRepository,
  PackageOwner,
  PackagePublisher,
  SourceRow,
  ArtifactRow,
  IconObject
} from "../packages/repository";
import { PackageError } from "@fossbilling/extension-packaging/errors";

export const MAX_PACKAGE_STORAGE_BYTES = 512 * 1024 * 1024;
export const MAX_PACKAGE_OBJECTS = 256;

function ownerPredicate() {
  return `EXISTS (SELECT 1 FROM developers d JOIN users u ON u.id=d.owner_user_id WHERE d.id=? AND d.profile_generation=? AND d.ownership_epoch=? AND d.owner_user_id=? AND u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM extensions e WHERE lower(e.identifier)=lower(?) AND e.developer_id!=d.id) AND (? IS NULL OR EXISTS (SELECT 1 FROM m2m_publisher_clients p WHERE p.client_id=? AND p.developer_id=d.id AND p.ownership_epoch=d.ownership_epoch AND p.revoked_at IS NULL)))`;
}
function ownerParams(owner: PackageOwner, id: string) {
  return [
    owner.id,
    owner.profile_generation,
    owner.ownership_epoch,
    owner.owner_user_id,
    id,
    owner.publisher_client_id ?? null,
    owner.publisher_client_id ?? null
  ];
}

export class PackageBuildDatabase implements PackageRepository {
  constructor(private readonly db: D1Database) {}
  async getOwner(
    userId: string,
    extensionId: string,
    publisher?: PackagePublisher | null
  ) {
    const owner = await this.db
      .prepare(
        `SELECT d.id,d.profile_generation,d.ownership_epoch,d.owner_user_id FROM developers d JOIN users u ON u.id=d.owner_user_id WHERE (? IS NULL AND d.owner_user_id=? OR d.id=? AND d.ownership_epoch=? AND EXISTS (SELECT 1 FROM m2m_publisher_clients p WHERE p.client_id=? AND p.developer_id=d.id AND p.ownership_epoch=d.ownership_epoch AND p.revoked_at IS NULL)) AND u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM extensions e WHERE lower(e.identifier)=lower(?) AND e.developer_id!=d.id)`
      )
      .bind(
        publisher?.clientId ?? null,
        userId,
        publisher?.developerId ?? null,
        publisher?.ownershipEpoch ?? null,
        publisher?.clientId ?? null,
        extensionId
      )
      .first<PackageOwner>();
    if (!owner)
      throw new PackageError(
        "FORBIDDEN",
        "An active owning developer profile is required",
        403
      );
    return { ...owner, publisher_client_id: publisher?.clientId };
  }
  async findSource(generation: string, identifier: string, version: string) {
    return this.db
      .prepare(
        "SELECT id,sha256,object_id FROM package_sources WHERE profile_generation=? AND extension_identifier=? AND version=?"
      )
      .bind(generation, identifier, version)
      .first<SourceRow>();
  }
  async findArtifact(sourceId: string, manifestHash: string) {
    return this.db
      .prepare(`${ARTIFACT_SELECT} WHERE a.source_id=? AND a.manifest_hash=?`)
      .bind(sourceId, manifestHash)
      .first<ArtifactRow>();
  }
  async hasIcon(sourceId: string) {
    return Boolean(
      await this.db
        .prepare("SELECT 1 FROM package_icons WHERE source_id=?")
        .bind(sourceId)
        .first()
    );
  }
  async reserveObject(
    owner: PackageOwner,
    extensionId: string,
    id: string,
    bytes: number
  ) {
    const result = await this.db
      .prepare(
        `INSERT INTO package_objects (id,created_by,bytes)
    SELECT ?,?,? WHERE ${ownerPredicate()}
    AND (SELECT count(*) FROM package_objects WHERE created_by=?) < ?
    AND (SELECT coalesce(sum(bytes),0) FROM package_objects WHERE created_by=?) + ? <= ?`
      )
      .bind(
        id,
        owner.owner_user_id,
        bytes,
        ...ownerParams(owner, extensionId),
        owner.owner_user_id,
        MAX_PACKAGE_OBJECTS,
        owner.owner_user_id,
        bytes,
        MAX_PACKAGE_STORAGE_BYTES
      )
      .run();
    if (!result.meta.changes)
      throw new PackageError(
        "PACKAGE_ADMISSION",
        "Ownership changed or package storage quota is exhausted",
        409
      );
  }
  async setObjectSize(id: string, bytes: number) {
    const result = await this.db
      .prepare(
        "UPDATE package_objects SET bytes=? WHERE id=? AND deleting=0 AND bytes>=?"
      )
      .bind(bytes, id, bytes)
      .run();
    if (!result.meta.changes)
      throw new PackageError(
        "PACKAGE_UNAVAILABLE",
        "Prepared package exceeds its storage reservation",
        503
      );
  }
  async removeObject(id: string) {
    await this.db
      .prepare("DELETE FROM package_objects WHERE id=?")
      .bind(id)
      .run();
  }
  async claimCleanup() {
    const result = await this.db
      .prepare(
        `UPDATE package_objects SET deleting=1 WHERE id IN (
    SELECT o.id FROM package_objects o WHERE (o.deleting=1 OR o.created_at < datetime('now','-1 day'))
    AND NOT EXISTS (SELECT 1 FROM package_jobs j WHERE j.upload_object_id=o.id AND j.status IN ('queued','processing'))
    AND NOT EXISTS (SELECT 1 FROM package_sources s WHERE s.object_id=o.id)
    AND NOT EXISTS (SELECT 1 FROM package_artifacts a WHERE a.object_id=o.id)
    AND NOT EXISTS (SELECT 1 FROM package_icons i WHERE i.avif_object_id=o.id OR i.png_object_id=o.id OR i.svg_object_id=o.id) LIMIT 100
  ) RETURNING id`
      )
      .all<{ id: string }>();
    return result.results.map((row) => row.id);
  }
  async finishCleanup(id: string) {
    await this.db
      .prepare(
        "UPDATE package_jobs SET upload_object_id=NULL WHERE upload_object_id=? AND status IN ('ready','failed')"
      )
      .bind(id)
      .run();
    await this.db
      .prepare("DELETE FROM package_objects WHERE id=? AND deleting=1")
      .bind(id)
      .run();
  }
  async linkSource(owner: PackageOwner, manifest: Manifest, source: SourceRow) {
    await this.db
      .prepare(
        `INSERT INTO package_sources (id,profile_generation,extension_identifier,version,sha256,object_id)
      SELECT ?,?,?,?,?,? WHERE ${ownerPredicate()} AND EXISTS (SELECT 1 FROM package_objects WHERE id=? AND deleting=0)
      ON CONFLICT DO NOTHING`
      )
      .bind(
        source.id,
        owner.profile_generation,
        manifest.id,
        manifest.version,
        source.sha256,
        source.object_id,
        ...ownerParams(owner, manifest.id),
        source.object_id
      )
      .run();
    return await this.db
      .prepare(
        "SELECT id,sha256,object_id FROM package_sources WHERE profile_generation=? AND extension_identifier=? AND version=?"
      )
      .bind(owner.profile_generation, manifest.id, manifest.version)
      .first<SourceRow>();
  }
  async ensureDraft(owner: PackageOwner, identifier: string) {
    // Reserve the permanent identity only after ZIP and icon validation succeeds.
    await this.db
      .prepare(
        `INSERT INTO extensions (id,identifier,developer_id,created_by)
    SELECT ?,?,?,? WHERE ${ownerPredicate()} ON CONFLICT DO NOTHING`
      )
      .bind(
        uuidv7(),
        identifier,
        owner.id,
        owner.owner_user_id,
        ...ownerParams(owner, identifier)
      )
      .run();
    const extension = await this.db
      .prepare(
        "SELECT id FROM extensions WHERE lower(identifier)=lower(?) AND developer_id=?"
      )
      .bind(identifier, owner.id)
      .first<{ id: string }>();
    if (!extension)
      throw new PackageError(
        "FORBIDDEN",
        "Extension ownership changed while preparing the package",
        403
      );
    return extension.id;
  }
  async linkArtifact(
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
  ) {
    await this.db
      .prepare(
        `INSERT INTO package_artifacts (id,source_id,manifest,manifest_hash,sha256,object_id,download_url)
    SELECT ?,?,?,?,?,?,? WHERE ${ownerPredicate()} AND EXISTS (SELECT 1 FROM package_objects WHERE id=? AND deleting=0)
    ON CONFLICT DO NOTHING`
      )
      .bind(
        artifact.id,
        artifact.sourceId,
        canonicalJson(manifest),
        artifact.manifestHash,
        artifact.sha256,
        artifact.objectId,
        artifact.downloadUrl,
        ...ownerParams(owner, manifest.id),
        artifact.objectId
      )
      .run();
    return this.findArtifact(artifact.sourceId, artifact.manifestHash);
  }
  async linkIcon(
    owner: PackageOwner,
    identifier: string,
    sourceId: string,
    objects: IconObject[]
  ) {
    const avif = objects.find((object) => object.format === "avif");
    const png = objects.find((object) => object.format === "png");
    const svg = objects.find((object) => object.format === "svg");
    const result = await this.db
      .prepare(
        `INSERT INTO package_icons (source_id,avif_object_id,avif_sha256,png_object_id,png_sha256,svg_object_id,svg_sha256)
    SELECT ?,?,?,?,?,?,? WHERE ${ownerPredicate()}
    AND NOT EXISTS (SELECT 1 FROM package_objects WHERE id IN (?,?,?) AND deleting=1)
    ON CONFLICT DO NOTHING`
      )
      .bind(
        sourceId,
        avif?.id ?? null,
        avif?.checksum ?? null,
        png?.id ?? null,
        png?.checksum ?? null,
        svg?.id ?? null,
        svg?.checksum ?? null,
        ...ownerParams(owner, identifier),
        avif?.id ?? null,
        png?.id ?? null,
        svg?.id ?? null
      )
      .run();
    return Boolean(result.meta.changes);
  }
  async getArtifact(id: string) {
    return this.db
      .prepare(`${ARTIFACT_SELECT} WHERE a.id=?`)
      .bind(id)
      .first<ArtifactRow>();
  }
  async isModerator(userId: string) {
    return Boolean(
      await this.db
        .prepare(
          "SELECT 1 FROM users WHERE id=? AND is_moderator=1 AND deleted_at IS NULL"
        )
        .bind(userId)
        .first()
    );
  }
  async correctionOwner(userId: string, sourceId: string, manifest: Manifest) {
    return this.db
      .prepare(
        `SELECT d.owner_user_id FROM package_sources s
      JOIN developers d ON d.profile_generation=s.profile_generation
      JOIN users moderator ON moderator.id=? AND moderator.is_moderator=1 AND moderator.deleted_at IS NULL
      WHERE s.id=? AND s.extension_identifier=? AND s.version=?
      AND EXISTS (SELECT 1 FROM package_artifacts a WHERE a.source_id=s.id AND a.published_at IS NOT NULL)`
      )
      .bind(userId, sourceId, manifest.id, manifest.version)
      .first<{ owner_user_id: string }>();
  }
  async getArtifactForReader(id: string, userId: string) {
    return this.db
      .prepare(
        `${ARTIFACT_SELECT} WHERE a.id=? AND (
      (a.published_at IS NOT NULL AND EXISTS (SELECT 1 FROM extensions e WHERE lower(e.identifier)=lower(s.extension_identifier) AND e.published_at IS NOT NULL AND e.delisted_at IS NULL))
      OR EXISTS (SELECT 1 FROM users u WHERE u.id=? AND u.deleted_at IS NULL AND (u.is_moderator=1 OR EXISTS (SELECT 1 FROM developers d WHERE d.profile_generation=s.profile_generation AND d.owner_user_id=u.id)))
    )`
      )
      .bind(id, userId)
      .first<ArtifactRow>();
  }
  async publishedIcon(identifier: string) {
    return this.db
      .prepare(
        `SELECT e.published_revision_id, coalesce(i.svg_object_id,i.png_object_id) AS object_key
      FROM extensions e
      JOIN package_artifacts a ON a.download_url=e.download_url AND a.published_at IS NOT NULL
      JOIN package_sources s ON s.id=a.source_id AND s.extension_identifier=lower(e.identifier)
      JOIN package_icons i ON i.source_id=s.id
      WHERE lower(e.identifier)=? AND e.published_at IS NOT NULL AND e.delisted_at IS NULL`
      )
      .bind(identifier)
      .first<{ published_revision_id: string; object_key: string | null }>();
  }
  async updatePublishedIcon(
    identifier: string,
    revisionId: string,
    url: string
  ) {
    const result = await this.db
      .prepare(
        "UPDATE extensions SET icon_url=? WHERE lower(identifier)=? AND published_revision_id=? AND delisted_at IS NULL AND icon_url IS NOT ?"
      )
      .bind(url, identifier, revisionId, url)
      .run();
    return Boolean(result.meta.changes);
  }
}
