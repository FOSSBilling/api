// Keyset pagination cursors. base64 of JSON, but neither half of that is safe
// by default: btoa throws on any code point above U+00FF, and atob followed by
// a plain JSON.parse will happily decode mojibake from a truncated or tampered
// cursor. Encoding goes through TextEncoder and decoding through a fatal
// TextDecoder so a corrupt cursor fails as a cursor rather than as a mangled
// query.
//
// Every cursor carries the version envelope, so a future change to any
// caller's key tuple can be recognised rather than misread as a valid cursor
// of the new shape. Callers supply only their own fields and a guard over
// them; the envelope is added and checked here.
const CURSOR_VERSION = 1;

export function encodeCursor(payload: Record<string, string>): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...payload, v: CURSOR_VERSION })
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// `isValid` runs over the decoded payload before it is handed back, so a
// cursor that survives base64 and JSON but decodes to the wrong shape is
// rejected here rather than reaching the query builder.
export function decodeCursor<T>(
  value: string,
  isValid: (
    parsed: Record<string, unknown>
  ) => parsed is T & Record<string, unknown>
): T | null {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    );
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const envelope = parsed as Record<string, unknown>;
    if (envelope.v !== CURSOR_VERSION) return null;
    return isValid(envelope) ? envelope : null;
  } catch {
    return null;
  }
}
