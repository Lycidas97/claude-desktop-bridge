import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

function mockCleanup(platform, { missing = false, failure = false, directory = false, extraEnv = {}, renameError = null } = {}) {
  const calls = [];
  const renames = [];
  const mkdtemps = [];
  const check = () => {
    if (missing) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    return { isDirectory: () => directory };
  };
  const doRename = (from, to) => {
    if (renameError) throw Object.assign(new Error(renameError), { code: renameError });
    renames.push([from, to]);
  };
  const mockFs = {
    lstatSync: check,
    mkdtempSync(prefix) { const dir = `${prefix}abc`; mkdtemps.push(dir); return dir; },
    renameSync: doRename,
    promises: {
      lstat: async () => check(),
      rename: async (from, to) => doRename(from, to),
    },
  };
  const execFileSync = (...args) => {
    calls.push(args);
    if (failure) throw Object.assign(new Error('trash command failed'), { code: 'ENOENT' });
  };
  const runPreload = (targetPlatform, env) => {
    const proc = { platform: targetPlatform, pid: 4242, env: { PRESERVE_ME: 'yes', ...env } };
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
  return { fs: mockFs, calls, renames, mkdtemps, process: mockProcess, reload: runPreload };
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

test('a recycle staging directory turns removals into renames that win-local-ci recycles once per run', async () => {
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
      { env: { ...process.env, BRIDGE_RECYCLE_STAGING: staging }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(join(directory, 'tree')) && !fs.existsSync(join(directory, 'file.txt')));
    const [processDir, ...others] = fs.readdirSync(staging);
    assert.equal(others.length, 0);
    assert.match(processDir, /^\d+-/u);
    assert.equal(fs.readFileSync(join(staging, processDir, '1', 'sub', 'a.txt'), 'utf8'), 'a');
    assert.equal(fs.readFileSync(join(staging, processDir, '2'), 'utf8'), 'f');

    for (const code of ['EXDEV', 'EBUSY', 'EPERM']) {
      const fallback = mockCleanup('win32', { extraEnv: { BRIDGE_RECYCLE_STAGING: 'D:\\staging' } });
      fallback.fs.mkdtempSync = prefix => `${prefix}1`;
      fallback.fs.renameSync = fallback.fs.promises.rename = () => {
        throw Object.assign(new Error('staging rename failed'), { code });
      };
      fallback.fs.rmSync('fixture');
      await fallback.fs.promises.rm('fixture');
      assert.equal(fallback.calls.length, 2, `${code} must use native recycling for sync and async removals`);
    }
    const failed = mockCleanup('win32', { failure: true, extraEnv: { BRIDGE_RECYCLE_STAGING: 'D:\\staging' } });
    failed.fs.mkdtempSync = prefix => `${prefix}1`;
    failed.fs.renameSync = failed.fs.promises.rename = () => {
      throw Object.assign(new Error('staging rename failed'), { code: 'EPERM' });
    };
    assert.throws(() => failed.fs.rmSync('fixture'), { code: 'ENOENT' });
    await assert.rejects(failed.fs.promises.rm('fixture'), { code: 'ENOENT' });
    assert.equal(failed.calls.length, 2);
    failed.fs.renameSync = failed.fs.promises.rename = () => {
      throw Object.assign(new Error('unexpected staging failure'), { code: 'EIO' });
    };
    assert.throws(() => failed.fs.rmSync('fixture'), { code: 'EIO' });
    await assert.rejects(failed.fs.promises.rm('fixture'), { code: 'EIO' });
    assert.equal(failed.calls.length, 2);
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
      env: recycleEnv(), encoding: 'utf8',
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
        env: recycleEnv(), encoding: 'utf8',
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

test('Mac CI stages every command per run and recycles its staging before completion', { skip: process.platform === 'win32' }, async () => {
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
        const staging = process.env.BRIDGE_RECYCLE_STAGING;
        const renderer = join(process.cwd(), \`renderer-\${process.pid}\`);
        mkdirSync(renderer);
        writeFileSync(join(renderer, 'index.html'), 'fixture');
        rmSync(renderer, { recursive: true });
        appendFileSync(${JSON.stringify(events)}, JSON.stringify({ args: process.argv.slice(2), staging,
          staged: !!staging && existsSync(staging) && readdirSync(staging).length > 0 }) + '\\n');
      `);
      await writeFile(join(binDir, 'npm'), `#!/bin/sh\nexec "${process.execPath}" --require "${join(repoDir, 'scripts/recycle-cleanup.cjs')}" "${fixture}" "$@"\n`, { mode: 0o755 });
      for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture']]) {
        assert.equal(spawnSync('git', args, { cwd: repoDir }).status, 0);
      }
      const child = spawn(process.execPath, [join(repoDir, 'scripts/local-ci.mjs'), '--skip-win', '--no-publish'], {
        cwd: repoDir, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
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
      assert.ok(run.records.every(record => record.staging && record.staged), 'Every Mac CI command must inherit staging');
      assert.equal(new Set(run.records.map(record => record.staging)).size, 1);
      assert.equal(fs.existsSync(run.records[0].staging), false, 'Run staging must be recycled before completion');
    }
    assert.notEqual(runs[0].records[0].staging, runs[1].records[0].staging);
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
    assert.ok(stop.includes(`ci-${runId}.bundle`) && stop.includes('bridge-recycle.exe'), stop);
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
  assert.match(winCiSource, /\$recycleStaging = .*recycle-staging-\$slot-[\s\S]*?\$env:BRIDGE_WIN_RECYCLE_EXE = \$recycleExe[\s\S]*?New-Item -ItemType Directory -Force -Path \$recycleStaging[\s\S]*?\$env:BRIDGE_RECYCLE_STAGING = \$recycleStaging[\s\S]*?\} finally \{[\s\S]*?bridge-recycle\.exe" \$recycleStaging/u);
  assert.match(winCiSource, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create[^\n]*start-server/u);
  assert.doesNotMatch(winCiSource, /ci-worktree|refs\/ci\/current|"bridge-ci-api36"/u);
  assert.doesNotMatch(localCiSource, /ci-worktree/u);
});

test('BRIDGE_RECYCLE_STAGING stages same-volume removals, falls back on EXDEV, propagates non-EXDEV errors, and loads idempotently', async () => {
  const stageBase = join(tmpdir(), 'bridge-stage');
  const staged = mockCleanup('darwin', { extraEnv: { BRIDGE_RECYCLE_STAGING: stageBase } });
  assert.equal(staged.fs[Symbol.for('bridge.recycleCleanupInstalled')], true);

  staged.fs.rmSync(join(tmpdir(), 'item-a'));
  await staged.fs.promises.unlink(join(tmpdir(), 'item-b'));
  await new Promise((resolve, reject) => staged.fs.rmdir(join(tmpdir(), 'item-c'), err => err ? reject(err) : resolve()));
  assert.equal(staged.calls.length, 0);
  assert.equal(staged.mkdtemps.length, 1);
  assert.deepEqual(staged.renames.map(([, to]) => to), [
    join(staged.mkdtemps[0], '1'),
    join(staged.mkdtemps[0], '2'),
    join(staged.mkdtemps[0], '3'),
  ]);

  // Double-require on the same fs module is a no-op and preserves existing install state.
  staged.reload('unsupported', {});
  staged.fs.rmSync(join(tmpdir(), 'item-d'));
  assert.equal(staged.calls.length, 0);
  assert.equal(staged.renames.at(-1)[1], join(staged.mkdtemps[0], '4'));

  // Cross-volume EXDEV falls back to the OS Recycle Bin command.
  const exdev = mockCleanup('darwin', { extraEnv: { BRIDGE_RECYCLE_STAGING: stageBase }, renameError: 'EXDEV' });
  exdev.fs.rmSync('cross-volume-sync');
  await exdev.fs.promises.rm('cross-volume-async');
  assert.equal(exdev.calls.length, 2);
  assert.ok(exdev.calls.every(call => call[0] === '/usr/bin/trash'));

  // Non-EXDEV rename errors surface directly without invoking OS trash or deleting.
  const eacces = mockCleanup('darwin', { extraEnv: { BRIDGE_RECYCLE_STAGING: stageBase }, renameError: 'EACCES' });
  assert.throws(() => eacces.fs.rmSync('denied-sync'), { code: 'EACCES' });
  await assert.rejects(eacces.fs.promises.rm('denied-async'), { code: 'EACCES' });
  assert.equal(eacces.calls.length, 0);
});

test('runSuites runs concurrently while preserving input entries order in summary.json and recycling per-run staging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge suite order-'));
  const prevStaging = process.env.BRIDGE_RECYCLE_STAGING;
  delete process.env.BRIDGE_RECYCLE_STAGING;
  try {
    const fixture = join(directory, 'timed-suite.mjs');
    await writeFile(fixture, `
      import { writeFileSync } from 'node:fs';
      const [mode, metaOut] = process.argv.slice(2, 4);
      const junit = process.argv.at(-1).split('=').slice(1).join('=');
      if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 180));
      writeFileSync(junit, '<testsuites/>');
      writeFileSync(metaOut, JSON.stringify({ finishedAt: Date.now(), staging: process.env.BRIDGE_RECYCLE_STAGING ?? null }));
    `);
    const slowMeta = join(directory, 'slow.json');
    const fastMeta = join(directory, 'fast.json');
    const entries = [
      { name: 'slow-first', cwd: directory, command: process.execPath, args: [fixture, 'slow', slowMeta] },
      { name: 'fast-second', cwd: directory, command: process.execPath, args: [fixture, 'fast', fastMeta] },
    ];
    assert.equal(await runSuites(entries, directory), 0);
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.map(result => result.suite), ['slow-first', 'fast-second']);
    const slow = JSON.parse(await readFile(slowMeta, 'utf8'));
    const fast = JSON.parse(await readFile(fastMeta, 'utf8'));
    assert.ok(fast.finishedAt < slow.finishedAt, 'suite #1 should finish while suite #0 is still running');
    assert.ok(slow.staging && slow.staging === fast.staging, 'child suites share a per-run BRIDGE_RECYCLE_STAGING directory');
    assert.equal(fs.existsSync(slow.staging), false, 'per-run staging directory is recycled after runSuites completes');

    const outerStaging = await mkdtemp(join(tmpdir(), 'bridge outer stage-'));
    process.env.BRIDGE_RECYCLE_STAGING = outerStaging;
    try {
      const outerOut = join(directory, 'outer');
      const outerMeta = join(directory, 'outer.json');
      assert.equal(await runSuites([{ name: 'inherited', cwd: directory, command: process.execPath, args: [fixture, 'fast', outerMeta] }], outerOut), 0);
      assert.equal(JSON.parse(await readFile(outerMeta, 'utf8')).staging, outerStaging);
      assert.equal(fs.existsSync(outerStaging), true, 'outer BRIDGE_RECYCLE_STAGING remains owned by caller');
    } finally {
      await rm(outerStaging, { recursive: true, force: true });
    }
  } finally {
    if (prevStaging === undefined) delete process.env.BRIDGE_RECYCLE_STAGING;
    else process.env.BRIDGE_RECYCLE_STAGING = prevStaging;
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

test('win-local-ci parallelizes WSL2 via setsid pipe-EOF, early emulator boot, and make:windows:from-client alongside Android APK', async () => {
  const desktopPkg = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'));
  assert.equal(desktopPkg.scripts['make:windows:from-client'], 'npm run build:bundle && node scripts/make-windows.mjs');

  const winCi = await readFile(new URL('./win-local-ci.ps1', import.meta.url), 'utf8');
  const syncIdx = winCi.indexOf('Sync git bundle ($Revision)');
  const wslStartIdx = winCi.indexOf('--exec setsid --wait bash -c');
  const emuStartIdx = winCi.indexOf('Starting headless WHPX AVD $avdName');
  const testInfraIdx = winCi.indexOf('Invoke-Checked "npm run test:infra"');
  const nsisParallelIdx = winCi.indexOf('make:windows:from-client -w @bridge/desktop');
  const androidSyncIdx = winCi.indexOf('sync:from-client -w @bridge/mobile');
  const nsisWaitIdx = winCi.indexOf('$nsisProc.WaitForExit()');
  const wslWaitIdx = winCi.indexOf('$wslProc.WaitForExit()');
  const recycleBundleIdx = winCi.indexOf('Recycle uploaded git bundle');

  assert.ok(syncIdx !== -1 && wslStartIdx > syncIdx && wslStartIdx < testInfraIdx, 'WSL2 starts immediately after git bundle sync before Windows tests');
  assert.ok(emuStartIdx !== -1 && emuStartIdx < testInfraIdx, 'Android Emulator boots before Windows test:infra and npm test');
  assert.ok(nsisParallelIdx !== -1 && androidSyncIdx > nsisParallelIdx && nsisWaitIdx > androidSyncIdx, 'make:windows:from-client runs in parallel with Android sync/Gradle before WaitForExit');
  assert.ok(wslWaitIdx > nsisWaitIdx, 'WSL2 is joined after Windows + Android QA steps');
  assert.match(winCi, /RedirectStandardInput\s*=\s*\$true/u);
  assert.match(winCi, /exec 3<&0 <\/dev\/null;[\s\S]*?cat <&3[\s\S]*?kill -TERM 0/u);
  // Keep --no-daemon for now: shared Gradle daemon lifecycle across concurrent ssh win slots is deferred (not yet empirically verified).
  assert.match(winCi, /gradlew\.bat"\s+assembleDebug\s+--no-daemon/u);
  const outerFinally = winCi.slice(winCi.indexOf('=== [WIN] ALL WINDOWS'));
  assert.ok(outerFinally.indexOf('StandardInput.Close()') !== -1 && outerFinally.indexOf('StandardInput.Close()') < outerFinally.indexOf('Recycle uploaded git bundle'), 'WSL2 stdin pipe closes in outer finally before recycling BundlePath');
  assert.ok(recycleBundleIdx > wslWaitIdx);
});
