import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/lib/adapters/node/**/*.test.ts",
      "test/services/extensions/v2/migrations.test.ts"
    ],
    testTimeout: 10000,

    // Code coverage configuration
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json", "html"],
      include: ["src/lib/adapters/node/**"]
    }
  }
});
