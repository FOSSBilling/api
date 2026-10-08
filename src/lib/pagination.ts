// Opt-in limit/offset pagination shared by the v1 list endpoints
// (extensions/v1 and central-alerts/v1). Absent params keep the full-list
// contract; a non-numeric limit is treated as absent rather than a 400 -
// these legacy surfaces have never validated query params and FOSSBilling's
// own client passes none. offset is the exception: only a caller opting into
// pagination can send it, so offset without a usable limit is invalid
// (matching the v2 pagination endpoints) rather than a silently ignored
// param that returns the full list.
export type LegacyPage = { limit: number; offset: number };

export function parseLegacyPagination(query: {
  limit?: string;
  offset?: string;
}): LegacyPage | "invalid" | undefined {
  const limitParam = Number(query.limit);
  const hasValidLimit =
    Number.isInteger(limitParam) && limitParam >= 1 && limitParam <= 100;
  if (query.offset !== undefined && !hasValidLimit) return "invalid";
  const offsetParam = query.offset === undefined ? 0 : Number(query.offset);
  return hasValidLimit
    ? {
        limit: limitParam,
        offset:
          Number.isInteger(offsetParam) && offsetParam >= 0 ? offsetParam : 0
      }
    : undefined;
}
