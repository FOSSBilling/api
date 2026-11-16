import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("wrangler/package.json");
const { bin } = JSON.parse(readFileSync(packagePath, "utf8"));
const child = spawn(
  process.execPath,
  [resolve(dirname(packagePath), bin.wrangler), ...process.argv.slice(2)],
  {
    env: { ...process.env, WRANGLER_BUILD_CONDITIONS: "workerd,worker,node" },
    stdio: "inherit"
  }
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
});
