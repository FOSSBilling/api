// Bounds for uploaded ZIPs and their decompressed contents.
export const PACKAGE_LIMITS = {
  sourceBytes: 5 * 1024 * 1024,
  expandedBytes: 16 * 1024 * 1024,
  entries: 500,
  pathLength: 1024,
  pathDepth: 32
} as const;
