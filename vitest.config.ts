import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/**/*.test.ts", "conformance/**/*.test.ts"],
    // Render-and-compare tests (atlas packing, engine runtimes) take several seconds on shared CI runners.
    testTimeout: 30_000,
  },
});
