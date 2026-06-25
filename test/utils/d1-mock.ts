/**
 * Mock D1 Database for testing
 * Implements the D1Database interface with in-memory storage
 */
import { CentralAlert } from "../../src/services/central-alerts/v1/interfaces";

type DatabaseAlert = Omit<CentralAlert, "buttons"> & {
  created_at: string;
  updated_at: string;
  buttons?: string; // JSON string in database
};

/**
 * Compare two semantic version strings (e.g. "1.2.3") numerically.
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 */
function compareVersions(a: string, b: string): number {
  const safeParseInt = (part: string): number => {
    const trimmed = part.trim();
    if (trimmed === "") {
      return 0;
    }
    const parsed = parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  const aParts = a.split(".").map((part) => safeParseInt(part));
  const bParts = b.split(".").map((part) => safeParseInt(part));
  const length = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < length; i++) {
    const aNum = aParts[i] ?? 0;
    const bNum = bParts[i] ?? 0;

    if (aNum < bNum) {
      return -1;
    }
    if (aNum > bNum) {
      return 1;
    }
  }

  return 0;
}

/**
 * Check whether `version` is within [minVersion, maxVersion] inclusive
 * using semantic version comparison. Only simple numeric versions (x.y.z)
 * are supported; pre-release or build metadata suffixes are not handled.
 */
function isVersionInRange(
  version: string,
  minVersion: string,
  maxVersion: string
): boolean {
  return (
    compareVersions(version, minVersion) >= 0 &&
    compareVersions(version, maxVersion) <= 0
  );
}

function notImplementedInMock(methodName: string): Error {
  return new Error(
    `MockD1Database.${methodName}() is not implemented for tests`
  );
}

export class MockD1Database implements D1Database {
  private alerts: DatabaseAlert[] = [];

  constructor() {
    // Initialize with test data
    this.alerts = [
      {
        id: "1",
        title: "SQL Injection Vulnerability",
        message:
          "A critical SQL injection vulnerability has been discovered. Please update immediately.",
        type: "danger",
        dismissible: false,
        min_fossbilling_version: "0.0.0",
        max_fossbilling_version: "0.5.2",
        include_preview_branch: false,
        buttons:
          '[{"text":"Security Advisory","link":"https://fossbilling.org/security-advisory","type":"danger"}]',
        datetime: "2023-01-15T10:30:00Z",
        created_at: "2023-01-15T10:30:00Z",
        updated_at: "2023-01-15T10:30:00Z"
      }
    ];
  }

  prepare(query: string): D1PreparedStatement {
    return {
      bind: (...params: unknown[]) => {
        return {
          all: async (): Promise<D1Result<DatabaseAlert>> => {
            // Simulate getting alerts by version
            if (
              query.includes("min_fossbilling_version") &&
              query.includes("max_fossbilling_version")
            ) {
              const version = params[0] as string;
              const filteredAlerts = this.alerts.filter((alert) => {
                // Check if it's the universal alert (applies to all versions)
                if (
                  alert.min_fossbilling_version === "0.0.0" &&
                  alert.max_fossbilling_version === "9999.9999.9999"
                ) {
                  return true;
                }
                // For version comparison, we need to check if version is within the alert's range
                return isVersionInRange(
                  version,
                  alert.min_fossbilling_version,
                  alert.max_fossbilling_version
                );
              });
              return {
                success: true,
                results: filteredAlerts,
                meta: {
                  duration: 0,
                  last_row_id: 0,
                  changes: 0,
                  served_by: "mock",
                  size_after: 0,
                  rows_read: 0,
                  rows_written: 0,
                  changed_db: false
                }
              };
            }

            // Simulate getting alert by ID
            if (query.includes("WHERE id = ?")) {
              const id = String(params[0]);
              const alert = this.alerts.find((a) => a.id === id);
              return {
                success: true,
                results: alert ? [alert] : [],
                meta: {
                  duration: 0,
                  last_row_id: 0,
                  changes: 0,
                  served_by: "mock",
                  size_after: 0,
                  rows_read: 0,
                  rows_written: 0,
                  changed_db: false
                }
              };
            }

            return {
              success: true,
              results: [],
              meta: {
                duration: 0,
                last_row_id: 0,
                changes: 0,
                served_by: "mock",
                size_after: 0,
                rows_read: 0,
                rows_written: 0,
                changed_db: false
              }
            };
          },

          first: async <T = Record<string, unknown>>(): Promise<T | null> => {
            // Simulate getting first result (for getAlertById)
            if (query.includes("WHERE id = ?")) {
              const id = params[0] as string;
              const alert = this.alerts.find((a) => a.id === id);
              return (alert as T | undefined) || null;
            }

            return null;
          },

          run: async (): Promise<D1Response> => {
            // Simulate INSERT operations
            if (query.includes("INSERT INTO central_alerts")) {
              const newAlert: DatabaseAlert = {
                id: params[0] as string,
                title: params[1] as string,
                message: params[2] as string,
                type: params[3] as "info" | "warning" | "danger" | "success",
                dismissible: params[4] as boolean,
                min_fossbilling_version: params[5] as string,
                max_fossbilling_version: params[6] as string,
                include_preview_branch: params[7] as boolean,
                datetime: params[8] as string,
                buttons: params[9] as string,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              };
              this.alerts.push(newAlert);
              return {
                success: true,
                meta: {
                  duration: 0,
                  last_row_id: this.alerts.length,
                  changes: 1,
                  served_by: "mock",
                  size_after: 0,
                  rows_read: 0,
                  rows_written: 1,
                  changed_db: true
                }
              };
            }

            // Simulate DELETE operations
            if (query.includes("DELETE FROM central_alerts")) {
              const id = params[0] as string;
              const initialLength = this.alerts.length;
              this.alerts = this.alerts.filter((a) => a.id !== id);
              const deletedCount = initialLength - this.alerts.length;
              const wasDeleted = deletedCount > 0;

              return {
                success: true,
                meta: {
                  duration: 0,
                  last_row_id: 0,
                  changes: deletedCount,
                  served_by: "mock",
                  size_after: 0,
                  rows_read: 1,
                  rows_written: deletedCount,
                  changed_db: wasDeleted
                }
              };
            }

            return {
              success: true,
              meta: {
                duration: 0,
                last_row_id: 0,
                changes: 0,
                served_by: "mock",
                size_after: 0,
                rows_read: 0,
                rows_written: 0,
                changed_db: false
              }
            };
          }
        };
      },

      all: async (): Promise<D1Result<DatabaseAlert>> => {
        // Simulate getting all alerts
        if (
          query.includes("FROM central_alerts") &&
          (query.includes("ORDER BY datetime DESC") ||
            query.includes('ORDER BY "datetime" DESC'))
        ) {
          return {
            success: true,
            results: this.alerts,
            meta: {
              duration: 0,
              last_row_id: 0,
              changes: 0,
              served_by: "mock",
              size_after: 0,
              rows_read: 0,
              rows_written: 0,
              changed_db: false
            }
          };
        }

        return {
          success: true,
          results: [],
          meta: {
            duration: 0,
            last_row_id: 0,
            changes: 0,
            served_by: "mock",
            size_after: 0,
            rows_read: 0,
            rows_written: 0,
            changed_db: false
          }
        };
      },

      first: async <T = Record<string, unknown>>(): Promise<T | null> => {
        // Simulate getting first result (for getAlertById without bind)
        if (query.includes("WHERE id = ?")) {
          // This shouldn't be called without bind, but handle it
          return null;
        }

        return null;
      }
    } as D1PreparedStatement;
  }

  dump(): Promise<ArrayBuffer> {
    throw notImplementedInMock("dump");
  }

  batch<T = unknown>(
    _statements: D1PreparedStatement[]
  ): Promise<D1Result<T>[]> {
    throw notImplementedInMock("batch");
  }

  exec(
    _query: string
  ): Promise<D1ExecResult> {
    throw notImplementedInMock("exec");
  }

  withSession(
    _constraintOrBookmark?: string
  ): D1DatabaseSession {
    throw notImplementedInMock("withSession");
  }
}

// Create a singleton instance
export const mockD1Database = new MockD1Database();
