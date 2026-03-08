import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
      reporters: ["verbose"],
    },
    hookTimeout: 1_200_000,
  },
});
