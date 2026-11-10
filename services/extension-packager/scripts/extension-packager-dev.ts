import { logError } from "@fossbilling/logging";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { handlePackageProcessing } from "../src/handler";

const port = Number(process.env.EXTENSION_PACKAGER_PORT || 8790);
createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  outgoing.on("close", () => {
    if (!outgoing.writableFinished) controller.abort();
  });
  try {
    const init = {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      body: ["GET", "HEAD"].includes(incoming.method ?? "GET")
        ? undefined
        : Readable.toWeb(incoming),
      signal: controller.signal,
      duplex: "half" as const
    };
    const response = await handlePackageProcessing(
      new Request(`http://localhost:${port}${incoming.url}`, init),
      (name) => process.env[name]
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(new Uint8Array(await response.arrayBuffer()));
  } catch (error) {
    logError("extensions/packages", "Local packager request failed", {
      error: error instanceof Error ? error.message : "Unknown error"
    });
    outgoing.writeHead(500);
    outgoing.end();
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`Extension packager listening on http://127.0.0.1:${port}`)
);
