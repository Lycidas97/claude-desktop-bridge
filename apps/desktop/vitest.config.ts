import { defineConfig } from "vitest/config";

const windows = process.platform === "win32";

export default defineConfig({
  test: {
    setupFiles: ["../../scripts/recycle-cleanup.cjs"],
    ...(windows ? { maxWorkers: 2, testTimeout: 60_000 } : {}),
  },
});
