import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts", "evals/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    passWithNoTests: false,
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
});
