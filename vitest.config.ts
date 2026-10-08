import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    coverage: {
      provider: "v8",
      include: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      exclude: [
        "**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
        "**/*.d.{ts,mts,cts}",
        "**/*.config.*",
        "coverage/**",
        "node_modules/**",
      ],
      thresholds: { 100: true },
    },
  },
});
