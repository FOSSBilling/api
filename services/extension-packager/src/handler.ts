import { logError } from "@fossbilling/logging";
import { timingSafeEqual } from "node:crypto";
import { b2ObjectStore } from "@fossbilling/extension-packaging/adapters/b2";
import { NodePackageImages } from "./images";
import { ProcessingInputSchema } from "@fossbilling/extension-packaging/processor";
import { processPackage } from "@fossbilling/extension-packaging/process";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import { boundedBytes } from "@fossbilling/extension-packaging/store";

// Standard Request/Response keeps the handler usable on Netlify or another Node host.
export async function handlePackageProcessing(
  request: Request,
  getEnv: (name: string) => string | undefined
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const secret = getEnv("EXTENSION_PACKAGER_SECRET");
  if (!secret)
    return Response.json(
      { error: { message: "Package processor is not configured" } },
      { status: 503, headers }
    );
  const supplied = Buffer.from(request.headers.get("Authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return new Response(null, { status: 401, headers });
  if (request.method !== "POST")
    return new Response(null, {
      status: 405,
      headers: { ...headers, Allow: "POST" }
    });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
  try {
    // A 64 KiB manifest string can expand in UTF-8, alongside request metadata.
    const bytes = await boundedBytes(request.body, 256 * 1024);
    let input;
    try {
      input = ProcessingInputSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes))
      );
    } catch {
      return Response.json(
        { error: { message: "Invalid processing request" } },
        { status: 422, headers }
      );
    }
    const result = await processPackage(
      input,
      b2ObjectStore(getEnv, "packages", signal),
      new NodePackageImages(),
      signal
    );
    return Response.json({ result }, { headers });
  } catch (error) {
    if (error instanceof PackageError && [413, 422].includes(error.status))
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: 422, headers }
      );
    if (error instanceof PackageError && error.code === "SOURCE_UNAVAILABLE")
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: 503, headers }
      );
    logError("extensions/packages", "Package processing failed", {
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return Response.json(
      { error: { message: "Package processing is temporarily unavailable" } },
      { status: 503, headers }
    );
  }
}
