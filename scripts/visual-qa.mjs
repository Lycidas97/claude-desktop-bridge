import { spawnSync } from "node:child_process";

// The Native catalog fixture owns its servers, theme matrix, accessibility checks
// and mobile/Desktop screenshots. Keep visual evidence on the same UI as E2E.
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "test:browser"], {
  stdio: "inherit",
  env: { ...process.env, BRIDGE_E2E_SCENARIOS: "session-catalog" },
  shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
