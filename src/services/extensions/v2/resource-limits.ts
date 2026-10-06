// Durable policy lives in migration 0026; change applied limits with a new migration.
export const MAX_RAW_BODY_BYTES = 512 * 1024;
export const MAX_CONTENT_BYTES = 256 * 1024;
export const RETENTION_DAYS = 180;
export const MAINTENANCE_BATCH_SIZE = 20;
export const MAX_ACCOUNT_BYTES = 25 * 1024 * 1024;
