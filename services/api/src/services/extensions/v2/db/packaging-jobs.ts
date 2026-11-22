import { GitHubPackageSourceSchema } from "@fossbilling/extension-packaging/processor";
import type { PackagingJob, PackagingJobRepository } from "../packages/jobs";
import { PackageError } from "@fossbilling/extension-packaging/errors";

interface JobRow {
  id: string;
  fingerprint: string;
  owner: string;
  target: string;
  upload_object_id: string | null;
  upload_sha256: string | null;
  github_asset: string | null;
  status: PackagingJob["status"];
  attempts: number;
  artifact_id: string | null;
  error_code: string | null;
  error_message: string | null;
  error_status: number | null;
  created_at: string;
  updated_at: string;
}
const job = (row: JobRow): PackagingJob => ({
  id: row.id,
  fingerprint: row.fingerprint,
  owner: JSON.parse(row.owner),
  target: JSON.parse(row.target),
  uploadObjectId: row.upload_object_id,
  uploadSha256: row.upload_sha256,
  githubAsset: row.github_asset
    ? GitHubPackageSourceSchema.parse(JSON.parse(row.github_asset))
    : undefined,
  status: row.status,
  attempts: row.attempts,
  artifactId: row.artifact_id,
  error: row.error_code
    ? {
        code: row.error_code,
        message: row.error_message!,
        status: row.error_status!
      }
    : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export class PackagingJobsDatabase implements PackagingJobRepository {
  constructor(
    private readonly db: D1Database,
    private readonly scope = ""
  ) {}

  async get(id: string) {
    const row = await this.db
      .prepare("SELECT * FROM package_jobs WHERE id=? AND dispatch_scope=?")
      .bind(id, this.scope)
      .first<JobRow>();
    return row ? job(row) : null;
  }
  async find(fingerprint: string) {
    const row = await this.db
      .prepare(
        "SELECT * FROM package_jobs WHERE fingerprint=? AND dispatch_scope=? AND status!='failed'"
      )
      .bind(fingerprint, this.scope)
      .first<JobRow>();
    return row ? job(row) : null;
  }
  async create(
    input: Pick<
      PackagingJob,
      | "fingerprint"
      | "owner"
      | "target"
      | "uploadObjectId"
      | "uploadSha256"
      | "githubAsset"
    >
  ) {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO package_jobs (id,fingerprint,owner_user_id,owner,target,upload_object_id,upload_sha256,github_asset,dispatch_scope)
      SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM package_jobs WHERE owner_user_id=?) < 256
      ON CONFLICT DO NOTHING`
      )
      .bind(
        id,
        input.fingerprint,
        input.owner.owner_user_id,
        JSON.stringify(input.owner),
        JSON.stringify(input.target),
        input.uploadObjectId,
        input.uploadSha256,
        input.githubAsset ? JSON.stringify(input.githubAsset) : null,
        this.scope,
        input.owner.owner_user_id
      )
      .run();
    const result = await this.find(input.fingerprint);
    if (!result)
      throw new PackageError(
        "PACKAGE_ADMISSION",
        "Packaging job allowance is exhausted; try again later",
        429
      );
    return result;
  }
  async claim(id: string, lease: string) {
    const row = await this.db
      .prepare(
        `UPDATE package_jobs SET status='processing',attempts=attempts+1,lease_id=?,lease_until=datetime('now','+20 minutes'),updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND dispatch_scope=? AND (status='queued' OR status='processing' AND lease_until<CURRENT_TIMESTAMP) RETURNING *`
      )
      .bind(lease, id, this.scope)
      .first<JobRow>();
    return row ? job(row) : null;
  }
  async complete(id: string, lease: string, artifactId: string) {
    await this.db
      .prepare(
        "UPDATE package_jobs SET status='ready',artifact_id=?,error_code=NULL,error_message=NULL,error_status=NULL,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_id=?"
      )
      .bind(artifactId, id, lease)
      .run();
  }
  async fail(
    id: string,
    lease: string,
    error: NonNullable<PackagingJob["error"]>,
    retry: boolean
  ) {
    await this.db
      .prepare(
        "UPDATE package_jobs SET status=?,error_code=?,error_message=?,error_status=?,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_id=?"
      )
      .bind(
        retry ? "queued" : "failed",
        error.code,
        error.message,
        error.status,
        id,
        lease
      )
      .run();
  }
  async nextForAlarm() {
    return this.db
      .prepare(
        `SELECT id, CASE
          WHEN status='processing' THEN unixepoch(lease_until) + 1
          WHEN attempts=0 THEN unixepoch(created_at)
          ELSE unixepoch(updated_at) + 60
        END AS due FROM package_jobs
        WHERE dispatch_scope=? AND status IN ('queued','processing')
        ORDER BY due, created_at, id LIMIT 1`
      )
      .bind(this.scope)
      .first<{ id: string; due: number }>();
  }
  async expire() {
    await this.db
      .prepare(
        `UPDATE package_jobs SET status='failed',error_code='PACKAGE_EXPIRED',error_message='Package processing expired. Please try again.',error_status=503,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE dispatch_scope=? AND status IN ('queued','processing') AND created_at<datetime('now','-1 day') AND (lease_until IS NULL OR lease_until<CURRENT_TIMESTAMP)`
      )
      .bind(this.scope)
      .run();
    await this.db
      .prepare(
        "DELETE FROM package_jobs WHERE id IN (SELECT id FROM package_jobs WHERE dispatch_scope=? AND status IN ('ready','failed') AND updated_at<datetime('now','-7 days') LIMIT 100)"
      )
      .bind(this.scope)
      .run();
  }
}
