/**
 * Type definitions for test files
 */

import { vi } from "vitest";
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

export interface VersionsResponse {
  result: Record<string, VersionInfo>;
  error_code: number;
  message: string | null;
  details?: {
    http_status?: number;
    error_code?: string;
  };
  stale?: boolean;
  warning?: string | null;
}

export interface VersionResponse {
  result: VersionInfo;
  error_code: number;
  message: string | null;
  details?: {
    http_status?: number;
    error_code?: string;
  };
  stale?: boolean;
  warning?: string | null;
}

export interface ChangelogResponse {
  result: string;
  error_code: number;
  message: string | null;
  details?: {
    http_status?: number;
    error_code?: string;
  };
  stale?: boolean;
  warning?: string | null;
}

export interface UpdateResponse {
  result: string;
  error_code: number;
  message: string | null;
  details?: {
    http_status?: number;
    error_code?: string;
  };
  stale?: boolean;
  warning?: string | null;
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
}

// GitHub Types
export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  published_at: string;
  prerelease: boolean;
  body: string;
  assets: GitHubAsset[];
}

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GitHubContentResponse {
  data: {
    content: string;
  };
}

// Mock Types
export interface MockFetchResponse<T = unknown> {
  ok: boolean;
  json: () => Promise<T>;
  text: () => Promise<string>;
  status: number;
  statusText: string;
}

export interface MockGitHubRequest {
  mockImplementation: (fn: (route: string) => Promise<unknown>) => void;
  mockRejectedValueOnce: (value: unknown) => void;
}

export interface MockGitHubGraphQL {
  mockImplementation: (fn: (query: string) => Promise<unknown>) => void;
  mockRejectedValueOnce: (value: unknown) => void;
}

// Environment Types
export interface TestEnv {
  CACHE_KV: {
    get: (key: string) => Promise<string | null>;
    put: (
      key: string,
      value: string,
      options?: { expirationTtl: number }
    ) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  AUTH_KV: {
    get: (key: string) => Promise<string | null>;
    put: (
      key: string,
      value: string,
      options?: { expirationTtl: number }
    ) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  DB_CENTRAL_ALERTS: unknown;
}

// Export CentralAlert type
export type { CentralAlert } from "../../src/services/central-alerts/v1/interfaces";

// Spy Types
export type FetchSpy = ReturnType<typeof vi.spyOn>;

export type KVPutSpy = {
  mockImplementation: (
    fn: (key: string, value: string, options?: unknown) => Promise<void>
  ) => void;
} & ReturnType<typeof vi.spyOn>;
