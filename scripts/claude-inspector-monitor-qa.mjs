// Uses an ordinary local TCP fixture, never the real Claude inspector.
import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { build } from "esbuild";

export async function verifyInspectorMonitor(root) {
  const repo = resolve(import.meta.dirname, "..");
  const modulePath = join(root, "inspector-monitor.mjs");
  await build({ entryPoints: [join(repo, "apps/desktop/src/claude-inspector-monitor.ts")], outfile: modulePath, bundle: true, platform: "node", format: "esm" });
  const { ClaudeInspectorMonitor, readInspectorConnections } = await import(modulePath);
  const accepted = new Set();
  const server = createServer((socket) => { accepted.add(socket); socket.on("close", () => accepted.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const alerts = [];
  let status;
  let scans = 0;
  let connection;
  const monitor = new ClaudeInspectorMonitor({
    port, intervalMs: 100,
    scan: async () => { scans++; return readInspectorConnections({ port, helperPath: join(repo, "apps/desktop/dist/native/inspector-process-path") }); },
    onUpdate: (next) => { status = next; },
    onAlert: (alert) => { alerts.push(alert); },
  });
  async function waitFor(predicate) {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Inspector fixture timed out: ${JSON.stringify(status)}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  try {
    connection = createConnection({ host: "127.0.0.1", port });
    await once(connection, "connect");
    await monitor.start();
    const nodePath = await realpath(process.execPath);
    assert.equal(status.state, "listening");
    assert.deepEqual(status.clients.map(({ pid, executablePath, approved }) => ({ pid, executablePath, approved })), [{ pid: process.pid, executablePath: nodePath, approved: false }]);
    await waitFor(() => scans >= 3);
    assert.equal(alerts.length, 1, "Continuous connection repeated the alert");
    connection.destroy();
    await waitFor(() => status.clients.length === 0);
    assert.equal(status.alerts.length, 1, "Disconnect discarded the alert history");
    connection = createConnection({ host: "127.0.0.1", port });
    await once(connection, "connect");
    await waitFor(() => alerts.length === 2);
    const archiveSource = join(root, "archive-fixture");
    await mkdir(join(archiveSource, "dist/native"), { recursive: true });
    await cp(join(repo, "apps/desktop/dist/native/inspector-process-path"), join(archiveSource, "dist/native/inspector-process-path"));
    const require = createRequire(import.meta.url);
    const asar = require("@electron/asar");
    const config = require(join(repo, "apps/desktop/forge.config.cjs"));
    await asar.createPackageWithOptions(archiveSource, join(root, "app.asar"), config.packagerConfig.asar);
    const { stdout } = await promisify(execFile)(join(root, "app.asar.unpacked/dist/native/inspector-process-path"), [String(process.pid)]);
    assert.equal(stdout.split("\0")[1], nodePath, "The packaged helper could not resolve the full executable path");
    const result = { status, proof: { realLsof: true, realProcPidpath: true, fullNodePath: nodePath, serverEndExcluded: true, continuousConnectionAlertOnce: true, reconnectAlertsAgain: true, disconnectedAlertRetained: true, asarUnpackedHelperRuns: true } };
    await writeFile(join(root, "inspector-proof.json"), JSON.stringify(result.proof, null, 2) + "\n");
    return result;
  } finally {
    monitor.close();
    connection?.destroy();
    for (const socket of accepted) socket.destroy();
    await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
}
