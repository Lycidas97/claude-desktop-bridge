import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";

let directory: string;
let entry: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bridge-history-retention-"));
  entry = join(directory, "history.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./history-retention.fixture.mjs", import.meta.url))],
    outfile: entry, bundle: true, platform: "node", format: "esm",
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)});` },
  });
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
it.each(["initial", "cursor", "fallback"])("releases superseded raw pages during %s history", mode => {
  for (const count of [8, 16]) {
    const result = execFileSync(process.execPath, ["--expose-gc", entry, mode, String(count)], { encoding: "utf8", timeout: 15000 });
    expect(JSON.parse(result)).toMatchObject({ mode, pages: count, released: true });
  }
}, 30000);
