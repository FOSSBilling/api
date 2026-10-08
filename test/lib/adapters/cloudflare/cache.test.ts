import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CloudflareKVAdapter } from "../../../../src/lib/adapters/cloudflare/cache";

// The adapter is a thin ICache view over KVNamespace; one round-trip smoke
// test pins the delegation without re-proving KV semantics per method.
describe("CloudflareKVAdapter", () => {
  let mockKV: KVNamespace;
  let adapter: CloudflareKVAdapter;

  beforeEach(() => {
    mockKV = {
      get: vi.fn().mockResolvedValue("test-value"),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    } as unknown as KVNamespace;

    adapter = new CloudflareKVAdapter(mockKV);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delegates get/put/delete to the KV namespace", async () => {
    await adapter.put("test-key", "test-value", { expirationTtl: 3600 });
    const result = await adapter.get("test-key");
    await adapter.delete("test-key");

    expect(mockKV.put).toHaveBeenCalledWith("test-key", "test-value", {
      expirationTtl: 3600
    });
    expect(mockKV.get).toHaveBeenCalledWith("test-key");
    expect(result).toBe("test-value");
    expect(mockKV.delete).toHaveBeenCalledWith("test-key");
  });
});
