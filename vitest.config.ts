import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: [
        "index.server.{ts,tsx}",
        "index.client.{ts,tsx}",
        "server/**/*.{ts,tsx}",
        "client/**/*.{ts,tsx}",
        "shared/**/*.{ts,tsx}",
      ],
      exclude: ["**/*.test.{ts,tsx}"],
      thresholds: { 100: true },
    },
  },
});
