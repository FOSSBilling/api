/**
 * Type definitions for test files
 */

import type { CentralAlert } from "../../src/services/central-alerts/v1/interfaces";

// API Response Types
export interface ApiResponse<T = unknown> {
  result: T;
  error_code: number;
  message: string | null;
  details?: {
    http_status?: number;
    error_code?: string;
  };
  stale?: boolean;
  warning?: string | null;
}

export interface CentralAlertsResponse {
  result: {
    alerts: CentralAlert[];
  };
  error: null;
}

// Version and Release Types
export interface VersionInfo {
  version: string;
  released_on: string;
  minimum_php_version: string;
  download_url: string;
  size_bytes: number;
  is_prerelease: boolean;
  github_release_id: number;
  changelog: string;
  digest: string | null;
}

// Mock Types
export interface MockGitHubRequest {
  mockImplementation: (fn: (route: string) => Promise<unknown>) => void;
  mockRejectedValueOnce: (value: unknown) => void;
}

export interface MockGitHubGraphQL {
  mockImplementation: (
    fn: (query: string, options?: unknown) => Promise<unknown>
  ) => void;
  mockRejectedValueOnce: (value: unknown) => void;
}
