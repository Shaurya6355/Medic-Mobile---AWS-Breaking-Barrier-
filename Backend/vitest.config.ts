import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The checks run the full answer grid, so the sign-off tests take seconds, more on a busy machine.
    testTimeout: 30_000,
  },
});
