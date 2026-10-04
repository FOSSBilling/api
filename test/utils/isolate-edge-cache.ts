import { afterEach, vi } from "vitest";

// Cloudflare has no CacheStorage.delete(). Give each test a fresh namespace
// while exercising the real Cache API, including waitUntil cache writes.
export function isolateEdgeCache() {
  const open = caches.open.bind(caches);
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());
  return () => {
    const suffix = crypto.randomUUID();
    const spy = vi
      .spyOn(caches, "open")
      .mockImplementation((name) => open(`${name}-${suffix}`));
    restore = () => spy.mockRestore();
  };
}
