#!/usr/bin/env node

import { spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WRANGLER_D1_COMMAND = [
  "wrangler",
  "d1",
  "execute",
  "api_central-alerts",
  "--local"
];

function executeWranglerCommand(args: string[]): void {
  const command = [...WRANGLER_D1_COMMAND, ...args];
  const result = spawnSync("npx", command, {
    encoding: "utf8",
    stdio: "pipe"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      [
        `Wrangler command failed: npx ${command.join(" ")}`,
        result.stderr.trim() ? `stderr: ${result.stderr.trim()}` : "",
        result.stdout.trim() ? `stdout: ${result.stdout.trim()}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}

function initializeDatabase(): void {
  console.log("Initializing Central Alerts Database...");

  const initSQLPath = join(__dirname, "..", "db", "init.sql");
  try {
    executeWranglerCommand(["--file", initSQLPath]);
  } catch (error) {
    console.error(`Failed SQL file: ${initSQLPath}`, error);
    throw error;
  }

  console.log("Database initialization completed successfully!");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    initializeDatabase();
  } catch (error) {
    console.error(
      `Database initialization failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

export { initializeDatabase };
