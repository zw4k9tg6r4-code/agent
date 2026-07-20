import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/test/**/*.test.ts", "tests/**/*.test.ts"],
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "packages/core/src/**/*.ts",
        "packages/policy/src/**/*.ts",
      ],
    },
  },
});
