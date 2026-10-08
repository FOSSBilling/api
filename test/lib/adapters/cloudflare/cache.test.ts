import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CloudflareKVAdapter } from "../../../../src/lib/adapters/cloudflare/cache";

// The adapter is a thin ICache view over KVNamespace; one passthrough test
// per method pins the delegation without re-proving KV semantics.
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

  it("delegates get to the KV namespace", async () => {
    const result = await adapter.get("test-key");
    expect(mockKV.get).toHaveBeenCalledWith("test-key");
    expect(result).toBe("test-value");
  });

  it("delegates put with options to the KV namespace", async () => {
    await adapter.put("test-key", "test-value", { expirationTtl: 3600 });
    expect(mockKV.put).toHaveBeenCalledWith("test-key", "test-value", {
      expirationTtl: 3600
    });
  });

  it("delegates delete to the KV namespace", async () => {
    await adapter.delete("test-key");
    expect(mockKV.delete).toHaveBeenCalledWith("test-key");
  });
});
