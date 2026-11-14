import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { runSuites } from './test.mjs';
import { recycleEnv } from './ci-run.mjs';
import { LOCAL_CI_STATUS_CONTEXT, recordAndPublishLocalCi, validateStatusRepo } from './local-ci.mjs';

const require = createRequire(import.meta.url);
const preload = await readFile(new URL('./recycle-cleanup.cjs', import.meta.url), 'utf8');

function mockCleanup(platform, { missing = false, failure = false, directory = false, extraEnv = {} } = {}) {
  const calls = [];
  const renames = [];
  const mkdtemps = [];
  const removals = [];
  const exits = [];
  const check = () => {
    if (missing) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    return { isDirectory: () => directory };
  };
  const doRename = (from, to) => {
    renames.push([from, to]);
  };
  const mockFs = {
    lstatSync: check,
    realpathSync: path => path,
    mkdtempSync(prefix) { const dir = `${prefix}abc`; mkdtemps.push(dir); return dir; },
    renameSync: doRename,
    promises: {
      lstat: async () => check(),
      rename: async (from, to) => doRename(from, to),
    },
  };
  for (const method of ['rm', 'unlink', 'rmdir']) {
    mockFs[`${method}Sync`] = (...args) => { removals.push([method, ...args]); };
    mockFs.promises[method] = async (...args) => { removals.push([method, ...args]); };
  }
  const execFileSync = (...args) => {
    calls.push(args);
    if (failure) throw Object.assign(new Error('trash command failed'), { code: 'ENOENT' });
  };
  const runPreload = (targetPlatform, env) => {
    const proc = { platform: targetPlatform, pid: 4242,
      env: { PRESERVE_ME: 'yes', BRIDGE_TEST_TEMP_ROOT: join(tmpdir(), 'mock-owned-root'), ...env },
      once: (event, callback) => { assert.equal(event, 'exit'); exits.push(callback); } };
    vm.runInNewContext(preload, {
      Buffer, URL, Symbol, process: proc,
      require(name) {
        if (name === 'node:fs') return mockFs;
        if (name === 'node:module') return { syncBuiltinESMExports() {} };
        if (name === 'node:child_process') return {
          execFileSync,
          execFile(command, args, options, callback) {
            try { execFileSync(command, args, options); callback(null, '', ''); }
            catch (error) { callback(error); }
          },
        };
        return require(name);
      },
    });
    return proc;
  };
  const mockProcess = runPreload(platform, extraEnv);
  return { fs: mockFs, calls, renames, mkdtemps, removals, exits, process: mockProcess, reload: runPreload };
}

test('suite failures, missing reports and startup errors preserve subsequent evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge ci 测试-'));
  try {
    const fixture = join(directory, 'suite.mjs');
    await writeFile(fixture, `
      import { writeFileSync } from 'node:fs';
      const mode = process.argv[2];
      console.log('fixture ' + mode);
      console.error('stderr ' + mode);
      if (mode !== 'missing') writeFileSync(process.argv.at(-1).split('=').slice(1).join('='), '<testsuites/>');
      process.exitCode = mode === 'fail' ? 7 : 0;
    `);
    const entries = ['pass', 'fail', 'missing', 'startup', 'after'].map(name => ({
      name, cwd: directory,
      command: name === 'startup' ? join(directory, 'no-such-executable') : process.execPath,
      args: [fixture, name],
    }));
    // A stale report must not make a reportless run pass.
    await writeFile(join(directory, 'missing.xml'), '<stale/>');
    assert.equal(await runSuites(entries, directory), 1);
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.map(result => result.passed), [true, false, false, false, true]);
    assert.equal(summary[1].exitCode, 7);
    assert.match(summary[2].errors.join(), /JUnit report is missing/);
    assert.match(summary[3].errors.join(), /ENOENT/);
    assert.match(await readFile(join(directory, 'after.log'), 'utf8'), /stderr after/);
    assert.equal(await runSuites([entries[0]], join(directory, 'all-pass')), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit suites do not inherit application build environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge suite env-'));
  const previous = process.env.VITE_BRIDGE_PUBLIC_RELAY_URL;
  process.env.VITE_BRIDGE_PUBLIC_RELAY_URL = 'wss://private-fixture.invalid/ws';
  try {
    const fixture = join(directory, 'env.mjs');
    await writeFile(fixture, `
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      assert.equal(process.env.VITE_BRIDGE_PUBLIC_RELAY_URL, undefined);
      writeFileSync(process.argv.at(-1).split('=').slice(1).join('='), '<testsuites/>');
    `);
    assert.equal(await runSuites([{ name: 'isolated-env', cwd: directory, command: process.execPath, args: [fixture] }], directory), 0);
  } finally {
    if (previous === undefined) delete process.env.VITE_BRIDGE_PUBLIC_RELAY_URL;
    else process.env.VITE_BRIDGE_PUBLIC_RELAY_URL = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('the installed Vitest accepts the worker/report flags with the recycle preload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge vitest 测试-'));
  try {
    await writeFile(join(directory, 'vitest.config.mjs'), `export default { test: { include: ['tiny.test.mjs'] } };`);
    await writeFile(join(directory, 'tiny.test.mjs'), `
      import { test, expect } from ${JSON.stringify(new URL('../node_modules/vitest/dist/index.js', import.meta.url).href)};
      test('fixture', () => expect(2 + 2).toBe(4));
    `);
    assert.equal(await runSuites([{
      name: 'tiny', cwd: directory, command: process.execPath,
      args: [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run',
        '--maxWorkers=2', '--reporter=default', '--reporter=junit'],
    }], join(directory, 'reports')), 0);
    assert.match(await readFile(join(directory, 'reports/tiny.xml'), 'utf8'), /<testcase/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('verify runs typecheck, tests and full build with inherited environment, and propagates failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge verify 测试-'));
  try {
    const fixture = join(directory, 'npm.mjs');
    const events = join(directory, 'events.jsonl');
    await writeFile(fixture, `
      import { appendFileSync } from 'node:fs';
      appendFileSync(process.env.EVENTS, JSON.stringify({ args: process.argv.slice(2), extra: process.env.EXTRA,
        options: process.env.NODE_OPTIONS }) + '\\n');
      process.exitCode = process.argv[2] === process.env.FAIL_ON ? 19 : 0;
    `);
    const env = { ...process.env, npm_execpath: fixture, EVENTS: events, EXTRA: 'retained',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --trace-warnings` };
    // Exercise a checkout path containing both spaces and non-ASCII characters.
    const runner = join(directory, 'ci-run.mjs');
    await copyFile(new URL('./ci-run.mjs', import.meta.url), runner);
    await copyFile(new URL('./recycle-cleanup.cjs', import.meta.url), join(directory, 'recycle-cleanup.cjs'));
    assert.equal(spawnSync(process.execPath, [runner, 'verify'], { env }).status, 0);
    const records = (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(records.map(record => record.args), [['run', 'typecheck'], ['test'], ['run', 'build']]);
    assert.ok(records.every(record => record.extra === 'retained' && record.options.includes('--trace-warnings')
      && record.options.includes('recycle-cleanup.cjs')));
    await writeFile(events, '');
    assert.equal(spawnSync(process.execPath, [runner, 'verify'], { env: { ...env, FAIL_ON: 'test' } }).status, 19);
    assert.equal((await readFile(events, 'utf8')).trim().split('\n').length, 2);
    assert.equal(spawnSync(process.execPath, [runner, 'npm', 'test'], { env: { ...env, FAIL_ON: 'test' } }).status, 19);
    assert.equal(spawnSync(process.execPath, [runner, 'verify'], {
      env: { ...env, npm_execpath: join(directory, 'missing.mjs') },
    }).status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preload paths with spaces preserve NODE_OPTIONS and extra environment', () => {
  const env = recycleEnv({ NODE_OPTIONS: '--trace-warnings', EXTRA: 'retained' });
  assert.equal(env.EXTRA, 'retained');
  assert.match(env.NODE_OPTIONS, /^--trace-warnings --require "/);
  assert.equal(spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, ...env } }).status, 0);
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} removal APIs call only the system recycle command`, async () => {
    const mock = mockCleanup(platform);
    for (const method of ['rm', 'unlink', 'rmdir']) {
      mock.fs[`${method}Sync`](Buffer.from('a fixture'));
      await mock.fs.promises[method](pathToFileURL(join(tmpdir(), 'a fixture')));
      await new Promise((resolve, reject) => mock.fs[method]('a fixture', error => error ? reject(error) : resolve()));
    }
    assert.equal(mock.calls.length, 9);
    assert.ok(mock.calls.every(call => call[0] === (platform === 'darwin' ? '/usr/bin/trash' : platform === 'linux' ? 'trash-put' : 'powershell.exe')));
    if (platform === 'win32') {
      assert.equal(mock.calls[0][2].env.PRESERVE_ME, 'yes');
      assert.match(mock.calls[0][1].at(-1), /SHFileOperation[\s\S]*0x0454/u);
      assert.ok(!mock.calls[0][1].at(-1).includes('a fixture'));
      const dir = mockCleanup(platform, { directory: true });
      dir.fs.rmSync('directory', { recursive: true });
      assert.match(dir.calls[0][1].at(-1), /SHFileOperation[\s\S]*0x0454/u);
      const compiled = mockCleanup(platform, { extraEnv: { BRIDGE_WIN_RECYCLE_EXE: 'D:\\work\\cache\\bridge-recycle.exe' } });
      compiled.fs.rmSync('a fixture');
      assert.equal(compiled.calls[0][0], 'D:\\work\\cache\\bridge-recycle.exe');
      assert.equal(compiled.calls[0][1].length, 1);
    }
  });
}

test('test-owned temporary removals bypass recycle staging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge staging 测试-'));
  try {
    const staging = join(directory, 'staging');
    await mkdir(join(directory, 'tree', 'sub'), { recursive: true });
    await writeFile(join(directory, 'tree', 'sub', 'a.txt'), 'a');
    await writeFile(join(directory, 'file.txt'), 'f');
    await mkdir(staging);
    const script = `
      const fs = require('node:fs');
      fs.rmSync(${JSON.stringify(join(directory, 'tree'))}, { recursive: true });
      fs.promises.unlink(${JSON.stringify(join(directory, 'file.txt'))}).then(() => fs.rmSync(${JSON.stringify(join(directory, 'gone'))}, { force: true }));
    `;
    const result = spawnSync(process.execPath, ['--require', fileURLToPath(new URL('./recycle-cleanup.cjs', import.meta.url)), '-e', script],
      { env: { ...process.env, BRIDGE_TEST_TEMP_ROOT: directory, BRIDGE_RECYCLE_STAGING: staging }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(join(directory, 'tree')) && !fs.existsSync(join(directory, 'file.txt')));
    assert.deepEqual(fs.readdirSync(staging), [], 'Owned temporary files must not accumulate in recycle staging');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cleanup keeps the physical host platform when application tests mock process.platform', () => {
  const mock = mockCleanup('win32');
  mock.process.platform = 'darwin';
  mock.fs.rmSync('a fixture');
  assert.equal(mock.calls[0][0], 'powershell.exe');
});

test('force ignores only missing paths; failed and unsupported trash never falls back', async () => {
  const missing = mockCleanup('darwin', { missing: true });
  missing.fs.rmSync('missing', { force: true });
  await missing.fs.promises.rm('missing', { force: true });
  await new Promise((resolve, reject) => missing.fs.rm('missing', { force: true }, error => error ? reject(error) : resolve()));
  assert.throws(() => missing.fs.unlinkSync('missing'), { code: 'ENOENT' });
  await assert.rejects(missing.fs.promises.rm('missing'), { code: 'ENOENT' });
  assert.equal(missing.calls.length, 0);
  for (const platform of ['darwin', 'linux', 'win32', 'unsupported']) {
    const mock = mockCleanup(platform, { failure: true });
    assert.throws(() => mock.fs.rmSync('present', { force: true }), /trash command failed|unsupported/);
    await assert.rejects(mock.fs.promises.rm('present', { force: true }), /trash command failed|unsupported/);
    assert.equal(mock.calls.length, platform === 'unsupported' ? 0 : 2);
  }
});

test('browser harness records proxy resets without failing intentional disconnect scenarios', async () => {
  const source = await readFile(new URL('./browser-e2e.mjs', import.meta.url), 'utf8');
  const logger = {};
  const infrastructureErrors = [];
  const logged = [];
  vm.runInNewContext(source.match(/logger\.error = \(message, options\) => \{[\s\S]*?\n  \};/u)[0], {
    logger, infrastructureErrors, logError: (message, options) => logged.push([message, options]),
  });
  const expected = [
    ['\u001b[31mws proxy error:\u001b[39m\nError: read ECONNRESET', { timestamp: true, error: { code: 'ECONNRESET' } }],
    ['ws proxy socket error:\nError: read ECONNRESET', { timestamp: true, error: { code: 'ECONNRESET' } }],
    ['\u001b[31mws proxy error:\u001b[39m\nError: write EPIPE', { timestamp: true, error: { code: 'EPIPE' } }],
    ['ws proxy socket error:\nError: write EPIPE', { timestamp: true, error: { code: 'EPIPE' } }],
  ];
  for (const [message, options] of expected) logger.error(message, options);
  assert.deepEqual(infrastructureErrors, []);
  const fatal = [
    ['ws proxy error: refused', { timestamp: true, error: { code: 'ECONNREFUSED' } }],
    ['http proxy error: /health', { timestamp: true, error: { code: 'ECONNRESET' } }],
    ['http proxy error: /health', { timestamp: true, error: { code: 'EPIPE' } }],
    ['transform error', { error: { code: 'ECONNRESET' } }],
    ['transform error', { error: { code: 'EPIPE' } }],
    ['\u001b[31mws proxy bypass error:\u001b[39m\nError: write EPIPE', { timestamp: true, error: { code: 'EPIPE' } }],
    ['ws proxy error: unknown failure', undefined],
    ['ws proxy error: timed out', { timestamp: true, error: { code: 'ETIMEDOUT' } }],
  ];
  for (const [message, options] of fatal) logger.error(message, options);
  assert.deepEqual(infrastructureErrors, fatal.map(([message]) => message));
  assert.deepEqual(logged, [...expected, ...fatal]);
});

test('Desktop startup leaves relay diagnostics to the configured Native connection', async () => {
  const { code } = await transform(await readFile(new URL('../apps/client/src/main.tsx', import.meta.url), 'utf8'), {
    loader: 'tsx', jsxFactory: 'jsx',
  });
  for (const desktop of [true, false]) {
    const probes = [], timers = [];
    vm.runInNewContext(code.replace(/^import .*;\r?\n/gmu, ''), {
      window: desktop ? { bridgeDesktop: {} } : {}, navigator: {},
      document: { getElementById: () => ({}) },
      jsx: () => ({}), StrictMode: {}, App: {}, createRoot: () => ({ render() {} }),
      installDiagnostics() {}, installSpecularHighlight() {},
      setTimeout(callback) { timers.push(callback); },
      runRelayConnectivityProbe(...args) { probes.push(args); return Promise.resolve(); },
    });
    for (const callback of timers) await callback();
    assert.equal(probes.length, desktop ? 0 : 1, desktop
      ? 'Desktop startup must not probe the compiled public relay'
      : 'Mobile startup behavior remains unchanged');
  }
});

test('scenario cleanup closes the page facade before late ACKs can see OPEN', async () => {
  const source = await readFile(new URL('./browser-e2e.mjs', import.meta.url), 'utf8');
  const setup = source.slice(source.indexOf('    await context.routeWebSocket('), source.indexOf('    page = await context.newPage();'));
  const closeRoutes = source.match(/^      for \(const route of serverRoutes\) await route\.close\(.*$/m)[0];
  let pageState = 1;
  let nativeState = 1;
  const serverRoute = { async close() { nativeState = 2; } };
  const socket = {
    url: () => 'ws://127.0.0.1:5811/ws',
    connectToServer: () => serverRoute,
    async close() { pageState = 3; await serverRoute.close(); },
  };
  await vm.runInNewContext(`(async () => {${setup}\n${closeRoutes}})()`, {
    URL, serverRoutes: [], errors: [], baseUrl: 'http://127.0.0.1:5811',
    relay: { url: 'ws://127.0.0.1:5812' },
    context: { async routeWebSocket(_pattern, handler) { handler(socket); } },
  });
  assert.equal(nativeState, 2, 'The fixture starts the owned native close handshake');
  assert.equal(pageState, 3, 'Late ACKs must not see an OPEN page facade after its native socket starts closing');
});

test('browser receipt assertion waits for a Native reply after the receipt is created', async () => {
  const source = await readFile(new URL('./browser-e2e.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  await eventually(() => host.nativeApproval.receipts().length, 4,');
  let state = 'dispatching';
  await vm.runInNewContext(`(async () => {
    ${source.match(/async function eventually\([\s\S]*?\n\}/u)[0]}
    ${source.slice(start, source.indexOf('  await host.syncNativeQueue(await host.nativeApproval.event(', start))}
  })()`, {
    assert, isDeepStrictEqual: require('node:util').isDeepStrictEqual,
    host: { nativeApproval: { receipts: () => [{}, {}, {}, { queueMode: 'steered', state }] } },
    delay: async () => { state = 'submitted'; },
  });
  assert.equal(state, 'submitted');
});

test('real system recycle command removes disposable files, readonly items, and junction trees without touching link targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge recycle-'));
  try {
    const fixture = join(directory, 'disposable.txt');
    await writeFile(fixture, 'infrastructure fixture');
    const result = spawnSync(process.execPath, ['-e', `require('node:fs').unlinkSync(process.argv[1])`, fixture], {
      env: { ...recycleEnv(), BRIDGE_TEST_TEMP_ROOT: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(fixture), false);

    // Hosted Windows Server runners reject Recycle Bin moves on NTFS junction subtrees (DE_ACCESSDENIEDSRC / 120).
    if (!(process.platform === 'win32' && process.env.RUNNER_ENVIRONMENT === 'github-hosted')) {
      const externalTarget = join(directory, 'external-target');
      const externalFile = join(externalTarget, 'keep.txt');
      const tree = join(directory, 'nested-tree');
      const readonlyFile = join(tree, 'readonly.txt');
      await mkdir(externalTarget, { recursive: true });
      await writeFile(externalFile, 'do not touch');
      await mkdir(tree, { recursive: true });
      await writeFile(readonlyFile, 'readonly fixture');
      await chmod(readonlyFile, 0o444);
      await symlink(externalTarget, join(tree, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');

      const treeResult = spawnSync(process.execPath, ['-e', `require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })`, tree], {
        env: { ...recycleEnv(), BRIDGE_TEST_TEMP_ROOT: '' }, encoding: 'utf8',
      });
      assert.equal(treeResult.status, 0, treeResult.stderr);
      assert.equal(fs.existsSync(tree), false);
      assert.equal(await readFile(externalFile, 'utf8'), 'do not touch');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local-ci status writeback enforces origin boundary, full-run qualification, pre-push deferral, and tree promotion', async () => {
  assert.equal(validateStatusRepo('Lycidas97/claude-desktop-bridge'), 'Lycidas97/claude-desktop-bridge');
  assert.throws(() => validateStatusRepo('czhmartinez/claude-desktop-bridge'), /Refusing to publish commit status to upstream/);
  assert.throws(() => validateStatusRepo('invalid-slug'), /Invalid GitHub repository slug/);

  const directory = await mkdtemp(join(tmpdir(), 'bridge-local-ci-status-'));
  try {
    const repoDir = join(directory, 'repo');
    const ghScript = join(directory, 'gh-stub.cjs');
    const ghLog = join(directory, 'gh-calls.jsonl');
    await mkdir(repoDir, { recursive: true });

    await writeFile(
      ghScript,
      `const fs = require('node:fs');
fs.appendFileSync(process.env.MOCK_GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.MOCK_GH_MODE === '422') {
  process.stderr.write('gh: No commit found for SHA: deadbeef (HTTP 422)\\n');
  process.exit(1);
}
if (process.env.MOCK_GH_MODE === '401') {
  process.stderr.write('gh: Bad credentials (HTTP 401)\\n');
  process.exit(1);
}
process.stdout.write('{"state":"success"}\\n');
`,
    );

    const runGit = (...gitArgs) => {
      const res = spawnSync('git', gitArgs, { cwd: repoDir, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout.trim();
    };
    runGit('init', '-q', '-b', 'feat/test');
    runGit('config', 'user.name', 'Bridge Test');
    runGit('config', 'user.email', 'test@example.invalid');
    await writeFile(join(repoDir, 'file.txt'), 'v1\n');
    runGit('add', 'file.txt');
    runGit('commit', '-q', '-m', 'initial');
    const prSha = runGit('rev-parse', 'HEAD');
    const prTree = runGit('rev-parse', 'HEAD^{tree}');

    const baseEnv = {
      ...process.env,
      BRIDGE_GH_EXEC: ghScript,
      MOCK_GH_LOG: ghLog,
      BRIDGE_GITHUB_STATUS_REPO: 'Lycidas97/claude-desktop-bridge',
    };

    // 1. Partial or dirty runs never write receipts or call gh
    for (const partial of [
      { skipWin: true },
      { skipMac: true },
      { skipWslLinux: true },
      { allowDirty: true },
    ]) {
      const skipped = await recordAndPublishLocalCi({
        cwd: repoDir,
        revision: prSha,
        tree: prTree,
        repo: 'Lycidas97/claude-desktop-bridge',
        env: baseEnv,
        ...partial,
      });
      assert.equal(skipped.qualified, false);
    }
    assert.equal(fs.existsSync(ghLog), false);

    // 2. Non-422 gh failure surfaces immediately
    await assert.rejects(
      recordAndPublishLocalCi({
        cwd: repoDir,
        revision: prSha,
        tree: prTree,
        repo: 'Lycidas97/claude-desktop-bridge',
        env: { ...baseEnv, MOCK_GH_MODE: '401' },
      }),
      /Bad credentials/,
    );

    // 3. Pre-push HTTP 422 saves receipt and defers cleanly
    await writeFile(ghLog, '');
    const deferred = await recordAndPublishLocalCi({
      cwd: repoDir,
      revision: prSha,
      tree: prTree,
      repo: 'Lycidas97/claude-desktop-bridge',
      env: { ...baseEnv, MOCK_GH_MODE: '422' },
    });
    assert.deepEqual(deferred, { qualified: true, published: false, deferred: true });

    // 4. Subsequent --publish CLI call publishes exact SHA status without re-running suites
    await writeFile(ghLog, '');
    const localCiCli = fileURLToPath(new URL('./local-ci.mjs', import.meta.url));
    const pub1 = spawnSync(process.execPath, [localCiCli, '--publish'], {
      cwd: repoDir,
      env: recycleEnv({ ...baseEnv, MOCK_GH_MODE: '200' }),
      encoding: 'utf8',
    });
    assert.equal(pub1.status, 0, pub1.stderr);
    const calls1 = (await readFile(ghLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls1.length, 1);
    assert.equal(calls1[0][1], `repos/Lycidas97/claude-desktop-bridge/statuses/${prSha}`);
    assert.ok(calls1[0].includes(`context=${LOCAL_CI_STATUS_CONTEXT}`));

    // 5. Squash-merged commit with byte-identical HEAD^{tree} promotes verified receipt
    runGit('checkout', '--orphan', 'main');
    runGit('commit', '-q', '-m', 'squash merge (#19)');
    const mainSha = runGit('rev-parse', 'HEAD');
    assert.notEqual(mainSha, prSha);
    assert.equal(runGit('rev-parse', 'HEAD^{tree}'), prTree);

    await writeFile(ghLog, '');
    const pub2 = spawnSync(process.execPath, [localCiCli, '--publish'], {
      cwd: repoDir,
      env: recycleEnv({ ...baseEnv, MOCK_GH_MODE: '200' }),
      encoding: 'utf8',
    });
    assert.equal(pub2.status, 0, pub2.stderr);
    const calls2 = (await readFile(ghLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls2[0][1], `repos/Lycidas97/claude-desktop-bridge/statuses/${mainSha}`);
    const descArg = calls2[0].find(arg => arg.startsWith('description='));
    assert.ok(descArg && descArg.slice('description='.length).length <= 140);

    // 6. Unverified modified tree is rejected with zero gh calls
    await writeFile(join(repoDir, 'file.txt'), 'v2-unverified\n');
    runGit('add', 'file.txt');
    runGit('commit', '-q', '-m', 'unverified change');
    await writeFile(ghLog, '');
    const pub3 = spawnSync(process.execPath, [localCiCli, '--publish'], {
      cwd: repoDir,
      env: recycleEnv({ ...baseEnv, MOCK_GH_MODE: '200' }),
      encoding: 'utf8',
    });
    assert.notEqual(pub3.status, 0);
    assert.equal(await readFile(ghLog, 'utf8'), '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Mac CI shares owned scratch across commands and deletes it before completion', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-mac-ci-staging-'));
  try {
    const runs = await Promise.all([0, 1].map(async index => {
      const repoDir = join(directory, `repo-${index}`);
      const binDir = join(directory, `bin-${index}`);
      const events = join(directory, `events-${index}.jsonl`);
      const fixture = join(directory, `npm-${index}.mjs`);
      await mkdir(join(repoDir, 'scripts'), { recursive: true });
      await mkdir(binDir);
      for (const name of ['local-ci.mjs', 'recycle-cleanup.cjs']) {
        await copyFile(new URL(`./${name}`, import.meta.url), join(repoDir, 'scripts', name));
      }
      await writeFile(fixture, `
        import { appendFileSync, existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
        import { join } from 'node:path';
        const root = process.env.BRIDGE_TEST_TEMP_ROOT;
        const renderer = join(root, \`renderer-\${process.pid}\`);
        mkdirSync(renderer);
        writeFileSync(join(renderer, 'index.html'), 'fixture');
        rmSync(renderer, { recursive: true });
        writeFileSync(join(root, 'leftover.txt'), 'creator owns final cleanup');
        appendFileSync(${JSON.stringify(events)}, JSON.stringify({ args: process.argv.slice(2), root,
          cleaned: !existsSync(renderer) }) + '\\n');
      `);
      await writeFile(join(binDir, 'npm'), `#!/bin/sh\nexec "${process.execPath}" --require "${join(repoDir, 'scripts/recycle-cleanup.cjs')}" "${fixture}" "$@"\n`, { mode: 0o755 });
      for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture']]) {
        assert.equal(spawnSync('git', args, { cwd: repoDir }).status, 0);
      }
      const child = spawn(process.execPath, [join(repoDir, 'scripts/local-ci.mjs'), '--skip-win', '--no-publish'], {
        cwd: repoDir, env: { ...process.env, BRIDGE_TEST_TEMP_ROOT: '', PATH: `${binDir}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const code = await new Promise((resolveExit, rejectExit) => {
        child.on('error', rejectExit);
        child.on('close', resolveExit);
      });
      return { code, output, records: (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
    }));
    for (const run of runs) {
      assert.equal(run.code, 0, run.output);
      assert.ok(run.records.some(record => record.args.join(' ') === 'run verify'));
      assert.ok(run.records.every(record => record.root && record.cleaned), 'Every Mac CI command must inherit owned scratch');
      assert.equal(new Set(run.records.map(record => record.root)).size, 1);
      assert.equal(fs.existsSync(run.records[0].root), false, 'Owned scratch must be deleted before completion');
    }
    assert.notEqual(runs[0].records[0].root, runs[1].records[0].root);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed Mac leg stops the remote Windows leg so its slot is released', { skip: process.platform === 'win32' }, async () => {
  // Windows OpenSSH keeps the remote powershell.exe (and its slot mutex) running after the local ssh client is killed.
  const directory = await mkdtemp(join(tmpdir(), 'bridge-local-ci-stop-'));
  try {
    const repoDir = join(directory, 'repo');
    const binDir = join(directory, 'bin');
    const sshLog = join(directory, 'ssh.log');
    const remoteStarted = join(directory, 'remote-started');
    await mkdir(join(repoDir, 'scripts'), { recursive: true });
    await mkdir(binDir);
    await copyFile(new URL('./local-ci.mjs', import.meta.url), join(repoDir, 'scripts', 'local-ci.mjs'));
    await copyFile(new URL('./recycle-cleanup.cjs', import.meta.url), join(repoDir, 'scripts', 'recycle-cleanup.cjs'));
    await writeFile(join(repoDir, 'scripts', 'win-local-ci.ps1'), '# fixture\n');
    const runGit = (...args) => assert.equal(spawnSync('git', args, { cwd: repoDir }).status, 0, `git ${args.join(' ')}`);
    runGit('init', '-q');
    runGit('add', '.');
    runGit('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture');
    await writeFile(join(binDir, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${sshLog}"\ncase "$*" in *-File*) touch "${remoteStarted}"; exec sleep 30;; esac\n`);
    await writeFile(join(binDir, 'scp'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(binDir, 'npm'), `#!/bin/sh\nwhile [ ! -f "${remoteStarted}" ]; do sleep 0.05; done\nexit 1\n`);
    for (const name of ['ssh', 'scp', 'npm']) await chmod(join(binDir, name), 0o755);

    const result = spawnSync(process.execPath, [join(repoDir, 'scripts', 'local-ci.mjs')], {
      cwd: repoDir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, BRIDGE_WIN_SSH_HOST: 'win-fixture' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.signal, null, 'local-ci must not hang on the blocked Windows leg');
    const calls = (await readFile(sshLog, 'utf8')).trim().split('\n');
    const runId = /win-local-ci-([\w-]+)\.ps1/u.exec(calls.find(call => call.includes('-File')))[1];
    const stop = calls.find(call => call.includes('taskkill') && call.includes(`win-local-ci-${runId}.ps1`));
    assert.ok(stop, `No remote stop for win-local-ci-${runId}.ps1:\n${calls.join('\n')}`);
    assert.match(stop, /win-fixture/u);
    assert.ok(stop.includes(`bridge-ci-${runId}`) && stop.includes('Remove-Item -LiteralPath'), stop);
    const logDir = join(repoDir, '.git', 'local-ci', 'logs');
    const [logName] = await readdir(logDir);
    assert.match(await readFile(join(logDir, logName), 'utf8'), /\[MAC\] npm run test:infra exited with code 1/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser E2E binds an ephemeral kernel port via httpServer.listen and local-ci isolates concurrent Windows runs per slot', async () => {
  const browserSource = await readFile(new URL('../scripts/browser-e2e.mjs', import.meta.url), 'utf8');
  const localCiSource = await readFile(new URL('./local-ci.mjs', import.meta.url), 'utf8');
  const winCiSource = await readFile(new URL('../scripts/win-local-ci.ps1', import.meta.url), 'utf8');

  assert.doesNotMatch(browserSource, /await vite\.listen\(\)/u, 'vite.listen() turns port: 0 into 5173');
  assert.match(browserSource, /vite\.httpServer\.listen\(port,\s*"127\.0\.0\.1"/u);

  const { createServer: createNetServer } = await import('node:net');
  const { createServer: createViteServer } = await import('vite');
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'bridge vite port cache-'));
  const blocker = createNetServer();
  const occupiedPort = await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port));
  });
  let viteA;
  let viteB;
  let viteConflict;
  try {
    viteA = await createViteServer({ configFile: false, cacheDir: join(cacheDirectory, 'a'), server: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
    viteB = await createViteServer({ configFile: false, cacheDir: join(cacheDirectory, 'b'), server: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
    await Promise.all([viteA, viteB].map(instance => new Promise((onListen, onError) => {
      instance.httpServer.once('error', onError);
      instance.httpServer.listen(0, '127.0.0.1', onListen);
    })));
    assert.notEqual(viteA.httpServer.address().port, 5173);
    assert.notEqual(viteB.httpServer.address().port, 5173);
    assert.notEqual(viteA.httpServer.address().port, viteB.httpServer.address().port);

    viteConflict = await createViteServer({ configFile: false, cacheDir: join(cacheDirectory, 'conflict'), server: { host: '127.0.0.1', port: occupiedPort, strictPort: true, open: false } });
    assert.equal(new Set([viteA, viteB, viteConflict].map(instance => instance.config.cacheDir)).size, 3);
    await assert.rejects(new Promise((onListen, onError) => {
      viteConflict.httpServer.once('error', onError);
      viteConflict.httpServer.listen(occupiedPort, '127.0.0.1', onListen);
    }), /EADDRINUSE/u);
  } finally {
    await viteConflict?.close();
    await viteB?.close();
    await viteA?.close();
    await new Promise(resolve => blocker.close(resolve));
    await rm(cacheDirectory, { recursive: true, force: true });
  }

  assert.match(localCiSource, /const runId = `\$\{revision\.slice\(0, 12\)\}-\$\{process\.pid\}-\$\{Date\.now\(\)\}`/u);
  assert.match(winCiSource, /System\.Threading\.Mutex.*Local\\ClaudeDesktopBridgeWinCi-\$_/u);
  assert.match(winCiSource, /WaitHandle\]::WaitAny\(\$slotMutexes\)/u);
  assert.match(winCiSource, /AbandonedMutexException[\s\S]*?\$slot = \$_\.Exception\.MutexIndex/u);
  assert.match(winCiSource, /\$slotMutexes\[\$slot\]\.ReleaseMutex\(\)/u);
  // Every per-run resource is keyed by slot; the shared D:\work\ci-worktree, bridge-ci-api36, and refs/ci/current are gone.
  assert.match(winCiSource, /\$ciWorktree = "\$workRoot\\ci-slot-\$slot"/u);
  assert.match(winCiSource, /"HEAD:refs\/ci\/slot-\$slot"/u);
  assert.match(winCiSource, /"-avd", \$avdName, "-port", "\$emulatorPort"/u);
  assert.match(winCiSource, /\$env:ANDROID_SERIAL = "emulator-\$emulatorPort"/u);
  assert.match(winCiSource, /CI_DIR="\/var\/tmp\/bridge-linux-ci-slot-\$slot"/u);
  assert.match(winCiSource, /\$recycleStaging = Join-Path \$tempDir "qa-staging"/u);
  assert.match(winCiSource, /if \(\$ownsTempRoot\) \{[\s\S]*?Remove-Item -LiteralPath \$tempDir -Recurse -Force/u);
  assert.doesNotMatch(winCiSource, /bridge-recycle\.exe" \$recycleStaging/u);
  assert.match(winCiSource, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create[^\n]*start-server/u);
  assert.doesNotMatch(winCiSource, /ci-worktree|refs\/ci\/current|"bridge-ci-api36"/u);
  assert.doesNotMatch(localCiSource, /ci-worktree/u);
});

test('owned scratch uses native sync, promise and callback APIs; other paths always recycle even with staging set', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const root = join(tmpdir(), 'owned-scratch');
    const mock = mockCleanup(platform, { extraEnv: { BRIDGE_TEST_TEMP_ROOT: root, BRIDGE_RECYCLE_STAGING: join(root, 'staging') } });
    for (const method of ['rm', 'unlink', 'rmdir']) {
      mock.fs[`${method}Sync`](Buffer.from(join(root, 'item')), { recursive: true });
      await mock.fs.promises[method](pathToFileURL(join(root, 'item')));
      await new Promise((resolve, reject) => mock.fs[method](join(root, 'item'), error => error ? reject(error) : resolve()));
    }
    assert.equal(mock.removals.length, 9);
    assert.equal(mock.calls.length, 0);
    assert.equal(mock.exits.length, 0, 'A child must not clean its inherited root');
    assert.equal(mock.fs[Symbol.for('bridge.recycleCleanupInstalled')], true);
    mock.reload('unsupported', {});
    mock.fs.rmSync(join(root, 'another'));
    assert.equal(mock.removals.length, 10, 'Reloading must not install another wrapper');
    for (const path of [root + '-sibling/file', join(tmpdir(), 'user-file'), 'artifacts/tests/desktop.xml', 'apps/desktop/out/make/installer.exe']) {
      mock.fs.rmSync(path);
      await mock.fs.promises.rm(path);
    }
    assert.equal(mock.calls.length, 8);
    assert.equal(mock.renames.length, 0, 'Non-temporary items must never enter disposable staging');
  }
  const failed = mockCleanup('darwin', { failure: true, extraEnv: { BRIDGE_RECYCLE_STAGING: 'staging' } });
  assert.throws(() => failed.fs.rmSync('user-file'), /trash command failed/);
  await assert.rejects(failed.fs.promises.rm('user-file'), /trash command failed/);
  assert.equal(failed.removals.length, 0);
});

test('directory symlinks do not authorize deletion of targets outside owned scratch', () => {
  const root = join(tmpdir(), 'owned-scratch');
  const mock = mockCleanup('darwin', { extraEnv: { BRIDGE_TEST_TEMP_ROOT: root } });
  mock.fs.realpathSync = path => path === join(root, 'external-link') ? join(tmpdir(), 'user-directory') : path;
  mock.fs.unlinkSync(join(root, 'external-link', 'user-file'));
  assert.equal(mock.calls.length, 1, 'An external target must recycle');
  assert.equal(mock.removals.length, 0);
  mock.fs.unlinkSync(join(root, 'external-link'));
  assert.equal(mock.removals.length, 1, 'The owned link itself is disposable');
});

test('only the creator cleans its fresh temporary root on exit', () => {
  const mock = mockCleanup('darwin', { extraEnv: { BRIDGE_TEST_TEMP_ROOT: '' } });
  assert.equal(mock.mkdtemps.length, 1);
  assert.equal(mock.exits.length, 1);
  assert.equal(mock.process.env.BRIDGE_TEST_TEMP_ROOT, mock.mkdtemps[0]);
  assert.equal(mock.process.env.TMPDIR, mock.mkdtemps[0]);
  assert.equal(mock.process.env.TEMP, mock.mkdtemps[0]);
  assert.equal(mock.process.env.TMP, mock.mkdtemps[0]);
  mock.exits[0]();
  assert.equal(mock.removals.length, 1);
  assert.equal(mock.removals[0][1], mock.mkdtemps[0]);
  assert.equal(mock.calls.length, 0);
});

test('runSuites preserves summary order and children retain the inherited temporary root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge suite order-'));
  try {
    const fixture = join(directory, 'suite.mjs');
    await writeFile(fixture, `
      import { writeFileSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      writeFileSync(process.argv.at(-1).split('=').slice(1).join('='), '<testsuites/>');
      writeFileSync(process.argv[2], JSON.stringify({ root: process.env.BRIDGE_TEST_TEMP_ROOT, tmp: tmpdir() }));
    `);
    const entries = ['first', 'second'].map(name => ({
      name, cwd: directory, command: process.execPath, args: [fixture, join(directory, `${name}.json`)],
    }));
    assert.equal(await runSuites(entries, directory), 0);
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.map(result => result.suite), ['first', 'second']);
    for (const name of ['first', 'second']) {
      const meta = JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'));
      assert.equal(meta.root, process.env.BRIDGE_TEST_TEMP_ROOT);
      assert.equal(meta.tmp, meta.root);
      assert.equal(fs.existsSync(meta.root), true, 'Suite children leave the caller-owned root alive');
    }
    const child = spawnSync(process.execPath, ['-e', 'console.log(process.env.BRIDGE_TEST_TEMP_ROOT)'], {
      env: { ...recycleEnv(), BRIDGE_TEST_TEMP_ROOT: '' }, encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(fs.existsSync(child.stdout.trim()), false, 'A fresh root is removed when its creator exits');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ci-run browser:nobuild invokes browser-e2e.mjs with recycle preload without rebuilding protocol or relay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge browser nobuild-'));
  try {
    const scriptsDir = join(directory, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    const events = join(directory, 'events.jsonl');
    const npmStub = join(directory, 'npm-stub.mjs');
    await writeFile(npmStub, `
      import { appendFileSync } from 'node:fs';
      appendFileSync(process.env.EVENTS, JSON.stringify({ kind: 'npm', args: process.argv.slice(2) }) + '\\n');
    `);
    await writeFile(join(scriptsDir, 'browser-e2e.mjs'), `
      import { appendFileSync } from 'node:fs';
      appendFileSync(process.env.EVENTS, JSON.stringify({ kind: 'browser', options: process.env.NODE_OPTIONS }) + '\\n');
    `);
    const runner = join(scriptsDir, 'ci-run.mjs');
    await copyFile(new URL('./ci-run.mjs', import.meta.url), runner);
    await copyFile(new URL('./recycle-cleanup.cjs', import.meta.url), join(scriptsDir, 'recycle-cleanup.cjs'));
    const result = spawnSync(process.execPath, [runner, 'browser:nobuild'], {
      env: { ...process.env, npm_execpath: npmStub, EVENTS: events },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const records = (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'browser');
    assert.match(records[0].options, /recycle-cleanup\.cjs/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('win-local-ci builds shared client once, overlaps make:windows:from-client with Android APK, and guards WSL2 setsid pipe-EOF before bundle recycle', async () => {
  const desktopPkg = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'));
  assert.equal(desktopPkg.scripts['make:windows:from-client'], 'npm run build:bundle && node scripts/make-windows.mjs');

  const winCi = await readFile(new URL('./win-local-ci.ps1', import.meta.url), 'utf8');
  const clientBuildIdx = winCi.indexOf('run build -w @bridge/client');
  const nsisParallelIdx = winCi.indexOf('make:windows:from-client -w @bridge/desktop');
  const androidSyncIdx = winCi.indexOf('sync:from-client -w @bridge/mobile');
  const nsisWaitIdx = winCi.indexOf('$nsisProc.WaitForExit()');
  const wslWaitIdx = winCi.indexOf('$wslProc.WaitForExit()');
  const recycleBundleIdx = winCi.indexOf('Clean uploaded git bundle');

  assert.ok(clientBuildIdx !== -1 && nsisParallelIdx > clientBuildIdx && androidSyncIdx > nsisParallelIdx && nsisWaitIdx > androidSyncIdx, 'shared client build precedes parallel make:windows:from-client and Android sync/Gradle');
  assert.ok(wslWaitIdx > nsisWaitIdx, 'WSL2 is joined after Windows + Android QA steps');
  assert.match(winCi, /RedirectStandardInput\s*=\s*\$true/u);
  assert.match(winCi, /exec 3<&0 <\/dev\/null;[\s\S]*?cat <&3[\s\S]*?kill -TERM 0/u);
  // Keep --no-daemon for now: shared Gradle daemon lifecycle across concurrent ssh win slots is deferred (not yet empirically verified).
  assert.match(winCi, /gradlew\.bat"\s+assembleDebug\s+--no-daemon/u);
  const outerFinally = winCi.slice(winCi.indexOf('=== [WIN] ALL WINDOWS'));
  assert.ok(outerFinally.indexOf('StandardInput.Close()') !== -1 && outerFinally.indexOf('StandardInput.Close()') < outerFinally.indexOf('Clean uploaded git bundle'), 'WSL2 stdin pipe closes in outer finally before recycling BundlePath');
  assert.ok(recycleBundleIdx > wslWaitIdx);
});

test('relay-contract-probe preserves subpath prefix for /health and build/env defaults use BIS + Cloudflare STUN', async () => {
  const { createServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const { PROTOCOL_VERSION } = await import('../packages/protocol/src/types.ts');
  const fixture = await mkdtemp(join(tmpdir(), 'bridge-relay-probe-source-'));
  await mkdir(join(fixture, 'scripts'), { recursive: true });
  await mkdir(join(fixture, 'packages/protocol/src'), { recursive: true });
  await mkdir(join(fixture, 'node_modules'), { recursive: true });
  await Promise.all([
    copyFile(new URL('./relay-contract-probe.mjs', import.meta.url), join(fixture, 'scripts/relay-contract-probe.mjs')),
    ...['endpoints.ts', 'types.ts'].map((name) => copyFile(
      new URL(`../packages/protocol/src/${name}`, import.meta.url),
      join(fixture, 'packages/protocol/src', name),
    )),
    symlink(fileURLToPath(new URL('../node_modules/ws', import.meta.url)), join(fixture, 'node_modules/ws'), 'junction'),
  ]);

  const seenHttpPaths = [];
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket) => {
    socket.once('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.version === PROTOCOL_VERSION) {
        socket.send(JSON.stringify({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'unknown room' }));
      } else {
        socket.send(JSON.stringify({ type: 'error', code: 'UPGRADE_REQUIRED', message: 'upgrade required' }));
      }
    });
  });
  const server = createServer((req, res) => {
    seenHttpPaths.push(req.url ?? '');
    if (req.url === '/bridge-relay/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: PROTOCOL_VERSION }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/bridge-relay/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const probePath = join(fixture, 'scripts/relay-contract-probe.mjs');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [probePath], {
        env: { ...process.env, BRIDGE_RELAY_URL: `ws://127.0.0.1:${port}/bridge-relay/ws` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(seenHttpPaths, ['/bridge-relay/health']);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      relayUrl: `ws://127.0.0.1:${port}/bridge-relay/ws`,
      protocolVersion: PROTOCOL_VERSION,
      currentHello: 'ROOM_NOT_FOUND',
      legacyHello: 'UPGRADE_REQUIRED',
    });
  } finally {
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }

  const buildMjs = await readFile(new URL('../apps/desktop/scripts/build.mjs', import.meta.url), 'utf8');
  const serviceRuntime = await readFile(new URL('../apps/desktop/src/app/service-runtime.ts', import.meta.url), 'utf8');
  const probeScript = await readFile(new URL('./relay-contract-probe.mjs', import.meta.url), 'utf8');
  const envExample = await readFile(new URL('../.env.example', import.meta.url), 'utf8');

  assert.doesNotMatch(buildMjs, /alioxis/iu);
  assert.match(buildMjs, /wss:\/\/bis\.zju\.edu\.cn\/bridge-relay\/ws/u);
  assert.match(buildMjs, /https:\/\/bis\.zju\.edu\.cn/u);
  assert.doesNotMatch(serviceRuntime, /alioxis/iu);
  assert.doesNotMatch(probeScript, /alioxis/iu);
  assert.doesNotMatch(envExample, /alioxis/iu);
  assert.match(envExample, /BRIDGE_ICE_SERVERS=\[\{"urls":"stun:stun\.cloudflare\.com:3478"\}\]/u);
});

test('picker-id resolves Magpie labels to Claude Desktop picker ids and rejects missing or ambiguous ones', async () => {
  const { configLibraryDir, resolvePickerId } = await import('./picker-id.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'bridge picker-id-'));
  try {
    await writeFile(join(directory, 'gateway.json'), JSON.stringify({ inferenceModels: [
      { name: 'mythos-magpie-1', labelOverride: 'bridge-runner · routing group' },
      { name: 'mythos-magpie-2', labelOverride: 'GPT-6.1-Sol · Codex' },
      { name: 'mythos-magpie-3', labelOverride: 'GPT-6.1 Sol · OpenAI' },
      { name: 'mythos-magpie-4', labelOverride: 'Gemini 4 Hydrogen · Antigravity' },
      { name: 'mythos-magpie-5', labelOverride: 'Gemini 4 Hydrogen · Google Gemini' },
    ] }));
    await writeFile(join(directory, 'notes.txt'), 'not json');
    assert.equal(resolvePickerId(directory, 'bridge-runner'), 'mythos-magpie-1');
    assert.equal(resolvePickerId(directory, 'GPT-6.1-Sol · Codex'), 'mythos-magpie-2');
    assert.equal(resolvePickerId(directory, 'GPT-6.1-Sol'), 'mythos-magpie-2');
    assert.throws(() => resolvePickerId(directory, 'bridge-docs'), /not in the model list.*restarts/);
    assert.throws(() => resolvePickerId(directory, 'Gemini 4 Hydrogen'), /matches .*Antigravity.*Google Gemini/);
    assert.equal(configLibraryDir('win32', { LOCALAPPDATA: 'C:\\L' }), join('C:\\L', 'Claude-3p', 'configLibrary'));
    assert.equal(configLibraryDir('linux', { CLAUDE_CONFIG_LIBRARY: directory }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
