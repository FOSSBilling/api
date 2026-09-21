// Cache-key surface for the v1 list body cache (see index.ts). Kept separate
// so extensions/v2's revalidateCatalogue can invalidate it after catalogue
// mutations without importing the v1 app module (which would drag the whole
// Hono app into v2's import graph for one function).
import { EXTENSION_TYPES } from "../v2/schemas/extensions";

const KEY_PREFIX = "extensions:v1:list";

export function listCacheKey(
  type: string | undefined,
  page: { limit: number; offset: number } | undefined
): string {
  // `type` is caller-controlled, so it must not collide with the key's own
  // structure or the unfiltered sentinel: present types are percent-encoded
  // (encodeURIComponent never emits a bare ":") behind a "%" prefix, which
  // leaves "all" - the unfiltered sentinel - unreachable as an encoded
  // value.
  const typePart = type === undefined ? "all" : `%${encodeURIComponent(type)}`;
  const pagePart = page ? `:${page.limit}:${page.offset}` : "";
  return `${KEY_PREFIX}:${typePart}${pagePart}`;
}

// KV has no wildcard delete, so enumerate the finite key surface: the
// unpaginated key per type plus "all" (paginated variants merely age out
// within the TTL). Best-effort: a failed delete only costs up to the list
// TTL of staleness, never correctness.
export const LIST_CACHE_TTL_SECONDS = 60;

export function invalidateListCache(
  kv: KVNamespace,
  waitUntil: (promise: Promise<unknown>) => void
): void {
  // Mirrors listCacheKey's encoding: the "all" sentinel for the unfiltered
  // list, "%"-prefixed encoded keys per type.
  const keys = [listCacheKey(undefined, undefined)].concat(
    EXTENSION_TYPES.map((type) => listCacheKey(type, undefined))
  );
  for (const key of keys) {
    waitUntil(kv.delete(key).catch(() => {}));
  }
}
