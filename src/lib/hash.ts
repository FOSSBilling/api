// SHA-256 as lowercase hex - used for cache/DO key derivation, transfer
// token hashing, and content-digest columns.
export async function sha256Hex(input: string | BufferSource): Promise<string> {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
