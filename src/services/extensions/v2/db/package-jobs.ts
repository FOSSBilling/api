import type { PackageJob, PackageJobRepository } from "../packages/jobs";
import { PackageError } from "../packages/errors";

interface JobRow {
  id: string;
  fingerprint: string;
  owner: string;
  manifest: string;
  source_id: string | null;
  upload_object_id: string | null;
  upload_sha256: string | null;
  status: PackageJob["status"];
  attempts: number;
  artifact_id: string | null;
  error_code: string | null;
  error_message: string | null;
  error_status: number | null;
  created_at: string;
  updated_at: string;
}
const job = (row: JobRow): PackageJob => ({
  id: row.id,
  fingerprint: row.fingerprint,
  owner: JSON.parse(row.owner),
  manifest: JSON.parse(row.manifest),
  sourceId: row.source_id,
  uploadObjectId: row.upload_object_id,
  uploadSha256: row.upload_sha256,
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

export class PackageJobsDatabase implements PackageJobRepository {
  constructor(private readonly db: D1Database) {}

  async get(id: string) {
    const row = await this.db
      .prepare("SELECT * FROM package_jobs WHERE id=?")
      .bind(id)
      .first<JobRow>();
    return row ? job(row) : null;
  }
  async find(fingerprint: string) {
    const row = await this.db
      .prepare(
        "SELECT * FROM package_jobs WHERE fingerprint=? AND status!='failed'"
      )
      .bind(fingerprint)
      .first<JobRow>();
    return row ? job(row) : null;
  }
  async create(
    input: Pick<
      PackageJob,
      | "fingerprint"
      | "owner"
      | "manifest"
      | "sourceId"
      | "uploadObjectId"
      | "uploadSha256"
    >
  ) {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO package_jobs (id,fingerprint,owner_user_id,owner,manifest,source_id,upload_object_id,upload_sha256)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM package_jobs WHERE owner_user_id=?) < 256
      ON CONFLICT DO NOTHING`
      )
      .bind(
        id,
        input.fingerprint,
        input.owner.owner_user_id,
        JSON.stringify(input.owner),
        JSON.stringify(input.manifest),
        input.sourceId,
        input.uploadObjectId,
        input.uploadSha256,
        input.owner.owner_user_id
      )
      .run();
    const result = await this.find(input.fingerprint);
    if (!result)
      throw new PackageError(
        "PACKAGE_ADMISSION",
        "Package job allowance is exhausted; try again later",
        429
      );
    return result;
  }
  async claim(id: string, lease: string) {
    const row = await this.db
      .prepare(
        `UPDATE package_jobs SET status='processing',attempts=attempts+1,lease_id=?,lease_until=datetime('now','+20 minutes'),updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND (status='queued' OR status='processing' AND lease_until<CURRENT_TIMESTAMP) RETURNING *`
      )
      .bind(lease, id)
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
    error: NonNullable<PackageJob["error"]>,
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
  async pending() {
    const result = await this.db
      .prepare(
        `SELECT id FROM package_jobs WHERE
      (status='queued' AND (enqueued_at IS NULL OR enqueued_at<datetime('now','-1 hour')))
      OR (status='processing' AND lease_until<CURRENT_TIMESTAMP) LIMIT 100`
      )
      .all<{ id: string }>();
    return result.results.map((row) => row.id);
  }
  async markEnqueued(id: string) {
    await this.db
      .prepare(
        "UPDATE package_jobs SET enqueued_at=CURRENT_TIMESTAMP WHERE id=?"
      )
      .bind(id)
      .run();
  }
  async expire() {
    await this.db
      .prepare(
        `UPDATE package_jobs SET status='failed',error_code='PACKAGE_EXPIRED',error_message='Package processing expired. Please try again.',error_status=503,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE status IN ('queued','processing') AND created_at<datetime('now','-1 day') AND (lease_until IS NULL OR lease_until<CURRENT_TIMESTAMP)`
      )
      .run();
    await this.db
      .prepare(
        "DELETE FROM package_jobs WHERE id IN (SELECT id FROM package_jobs WHERE status IN ('ready','failed') AND updated_at<datetime('now','-7 days') LIMIT 100)"
      )
      .run();
  }
}
