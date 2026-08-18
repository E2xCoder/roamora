import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests never reach a live third-party API — every external call goes
    // through a provider interface precisely so it can be mocked (spec §84).
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // `server-only` throws on import outside a React Server Component.
      // Server modules are plain functions under test, so it is stubbed out.
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts"),
    },
  },
});
