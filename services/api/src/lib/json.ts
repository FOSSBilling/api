// D1 stores these columns as TEXT, so a row value is either the raw JSON
// string, or already-parsed (e.g. read via a mock/fixture in tests) -
// malformed or unexpected shapes fall back rather than throwing, since a
// single bad row shouldn't break listing/reading everything else.
export function parseJSON<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value !== undefined && value !== null ? (value as T) : fallback;
}
