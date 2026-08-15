import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const setupPath = fileURLToPath(new URL("./vitest.setup.ts", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: [setupPath],
    include: ["packages/**/test/**/*.test.ts", "test/**/*.test.ts", "tests/**/*.test.ts"],
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "packages/**/src/**/*.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 72,
        functions: 85,
        lines: 80,
        "packages/tools/src/workspace-path.ts": { lines: 90, branches: 90 },
        "packages/cli/src/session-store.ts": { lines: 75, branches: 65 },
        "packages/providers/src/sse.ts": { lines: 95, branches: 85 },
        "packages/providers/src/openai-compatible.ts": { lines: 80, branches: 75 },
        "packages/tools/src/shell-execute.ts": { lines: 75, branches: 75 },
        "packages/tools/src/shell-process.ts": { lines: 70, branches: 60 },
        "packages/tools/src/file-patch.ts": { lines: 70, branches: 65 },
        "packages/tools/src/atomic-file.ts": { lines: 75, branches: 65 }
      }
    },
  },
});
