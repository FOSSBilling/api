import { PackageError } from "./errors";

export interface PackageStore {
  put(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    checksum: string
  ): Promise<void>;
  get(
    key: string,
    checksum?: string
  ): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
}

export async function boundedBytes(
  body: ReadableStream<Uint8Array> | null,
  limit: number
) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new PackageError(
          "BODY_TOO_LARGE",
          "Upload exceeds size limit",
          413
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
