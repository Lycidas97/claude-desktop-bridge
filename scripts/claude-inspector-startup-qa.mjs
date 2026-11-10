import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { recycleEnv } from './ci-run.mjs';

assert.equal(process.platform, 'darwin', 'Native menu QA requires macOS');
const require = createRequire(import.meta.url);
const electron = require('electron');
const output = resolve(process.argv[2] ?? 'output/inspector-startup-qa');
await mkdir(output, { recursive: true });
await build({ entryPoints: ['apps/desktop/src/claude-inspector-startup.ts'], outfile: join(output, 'startup.mjs'), bundle: true, platform: 'node', format: 'esm' });
await build({ entryPoints: ['apps/desktop/src/claude-desktop-inspector.ts'], outfile: join(output, 'inspector.mjs'), bundle: true, platform: 'node', format: 'esm' });
const { ClaudeInspectorStartup, claudeInspectorMenu, parseInspectorDesktopProcesses } = await import(join(output, 'startup.mjs'));
const { ClaudeDesktopInspector } = await import(join(output, 'inspector.mjs'));
const run = promisify(execFile);
const evidence = { fixtureOnly: true, productionInspectorConnected: false, steps: [] };
const recordPath = join(output, 'launch-record.json');
let child;
let origin;
let port;
let nativeClient;
async function control(path = '/status') { return (await fetch(origin + path)).json(); }
async function listening() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
    return response.ok && (await response.json()).some(target => target.type === 'node');
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') return false;
    throw error;
  }
}
const processes = async () => {
  const { stdout } = await run('/bin/ps', ['-p', String(child.pid), '-o', 'pid=,lstart=,comm='], { env: { ...process.env, LC_ALL: 'en_US.UTF-8' } });
  evidence.lastProcessObservation = { stdout, expectedExecutable: electron };
  return parseInspectorDesktopProcesses(stdout, [electron]);
};
async function start() {
  const reserved = createServer().listen(0, '127.0.0.1');
  await once(reserved, 'listening');
  port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const directory = await mkdtemp(join(output, 'electron-'));
  const env = recycleEnv();
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electron, [resolve('scripts/fixtures/inspector-startup-host.cjs'), directory, String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  child.on('error', error => { logs += String(error); });
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      const fixture = JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8'));
      assert.equal(fixture.pid, child.pid);
      origin = `http://127.0.0.1:${fixture.controlPort}`;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      assert.equal(child.exitCode, null, logs);
      assert.ok(Date.now() < deadline, 'Fixture readiness timed out: ' + logs);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  child.once('exit', () => { void writeFile(join(directory, 'electron.log'), logs); });
  assert.equal(await listening(), false);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  await control('/quit');
  await exited;
}
try {
  await start();
  let startup = new ClaudeInspectorStartup({ recordPath, processes });
  assert.match(await startup.check(false), /等待/);
  assert.equal((await control()).presses, 0);
  evidence.steps.push({ step: 'menu-not-ready', presses: 0 });
  await control('/ready');
  const result = await startup.check(false);
  assert.match(result, /尚未开放/);
  assert.equal(await listening(), true, 'Native menu callback must open a real Node inspector');
  assert.equal((await control()).presses, 1);
  assert.equal(await startup.check(true), undefined);
  evidence.steps.push({ step: 'native-menu-opened-inspector', presses: 1, discovery: true, identity: (await processes())[0].identity });

  nativeClient = new ClaudeDesktopInspector({ origin: `http://127.0.0.1:${port}` });
  await nativeClient.connect();
  assert.equal((await nativeClient.call('getAll')).length, 1);
  await nativeClient.close(); nativeClient = undefined;
  evidence.steps.push({ step: 'existing-inspector-connects-to-fixture-LocalSessions', sessions: 1 });
  assert.equal(await claudeInspectorMenu(child.pid, true), 'enabled');
  assert.equal((await control()).presses, 1, 'A checked checkbox must never be toggled off');

  await control('/manual-close');
  assert.equal(await listening(), false);
  await startup.check(false);
  startup = new ClaudeInspectorStartup({ recordPath, processes });
  await startup.check(false);
  assert.equal((await control()).presses, 1);
  assert.equal(await listening(), false);
  evidence.steps.push({ step: 'manual-close-and-Bridge-restart', presses: 1, remainsClosed: true });
  await stop();

  await start();
  await control('/ready');
  await control('/deny-policy');
  assert.match(await startup.check(false), /尚未开放/);
  assert.match(await startup.check(false), /尚未开放/);
  assert.equal((await control()).presses, 1);
  assert.equal(await listening(), false);
  evidence.steps.push({ step: 'new-process-native-policy-denied', presses: 1, remainsClosed: true });
  await stop();

  await start();
  await control('/ready');
  await claudeInspectorMenu(child.pid, true);
  assert.equal(await listening(), true);
  await startup.check(true);
  await control('/manual-close');
  await startup.check(false);
  assert.equal((await control()).presses, 1);
  evidence.steps.push({ step: 'already-open-new-process-skipped', presses: 1, remainsClosed: true });
  await stop();

  await start();
  await control('/ready');
  await control('/disable-menu');
  const disabled = await startup.check(false);
  assert.match(disabled, /自动开启失败.*菜单不可用/s);
  assert.doesNotMatch(disabled, /on run argv/, 'Diagnostics should contain the system error without the AppleScript program');
  assert.equal(await startup.check(false), disabled);
  assert.equal(await new ClaudeInspectorStartup({ recordPath, processes }).check(false), disabled);
  assert.equal((await control()).presses, 0);
  assert.equal(await listening(), false);
  evidence.steps.push({ step: 'disabled-native-menu-error-persists', presses: 0, remainsClosed: true });
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.failure = String(error.stack ?? error);
  throw error;
} finally {
  await nativeClient?.close();
  await stop();
  await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
