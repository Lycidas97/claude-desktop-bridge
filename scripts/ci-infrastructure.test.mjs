import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { runSuites } from './test.mjs';
import { recycleEnv } from './ci-run.mjs';
import { LOCAL_CI_STATUS_CONTEXT, recordAndPublishLocalCi, validateStatusRepo } from './local-ci.mjs';

const require = createRequire(import.meta.url);
const preload = await readFile(new URL('./recycle-cleanup.cjs', import.meta.url), 'utf8');

function mockCleanup(platform, { missing = false, failure = false, directory = false, extraEnv = {} } = {}) {
  const calls = [];
  const check = () => {
    if (missing) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    return { isDirectory: () => directory };
  };
  const mockFs = { lstatSync: check, promises: { lstat: async () => check() } };
  const execFileSync = (...args) => {
    calls.push(args);
    if (failure) throw Object.assign(new Error('trash command failed'), { code: 'ENOENT' });
  };
  const mockProcess = { platform, env: { PRESERVE_ME: 'yes', ...extraEnv } };
  vm.runInNewContext(preload, {
    Buffer, URL, process: mockProcess,
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
  return { fs: mockFs, calls, process: mockProcess };
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
    logger, infrastructureErrors, logError: message => logged.push(message),
  });
  for (const message of ['\u001b[31mws proxy error:\u001b[39m\nError: read ECONNRESET', 'ws proxy socket error:\nError: read ECONNRESET']) {
    logger.error(message, { error: { code: 'ECONNRESET' } });
  }
  assert.deepEqual(infrastructureErrors, []);
  for (const [message, options] of [
    ['ws proxy error: refused', { error: { code: 'ECONNREFUSED' } }],
    ['http proxy error: /health', { error: { code: 'ECONNRESET' } }],
    ['transform error', { error: { code: 'ECONNRESET' } }],
    ['ws proxy error: unknown failure', undefined],
  ]) logger.error(message, options);
  assert.equal(infrastructureErrors.length, 4);
  assert.equal(logged.length, 6);
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

test('browser E2E binds an ephemeral kernel port via httpServer.listen and local-ci isolates concurrent Windows runs per slot', async () => {
  const browserSource = await readFile(new URL('../scripts/browser-e2e.mjs', import.meta.url), 'utf8');
  const localCiSource = await readFile(new URL('./local-ci.mjs', import.meta.url), 'utf8');
  const winCiSource = await readFile(new URL('../scripts/win-local-ci.ps1', import.meta.url), 'utf8');

  assert.doesNotMatch(browserSource, /await vite\.listen\(\)/u, 'vite.listen() turns port: 0 into 5173');
  assert.match(browserSource, /vite\.httpServer\.listen\(port,\s*"127\.0\.0\.1"/u);

  const { createServer: createNetServer } = await import('node:net');
  const { createServer: createViteServer } = await import('vite');
  const blocker = createNetServer();
  const occupiedPort = await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port));
  });
  let viteA;
  let viteB;
  let viteConflict;
  try {
    viteA = await createViteServer({ configFile: false, server: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
    viteB = await createViteServer({ configFile: false, server: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
    await Promise.all([viteA, viteB].map(instance => new Promise((onListen, onError) => {
      instance.httpServer.once('error', onError);
      instance.httpServer.listen(0, '127.0.0.1', onListen);
    })));
    assert.notEqual(viteA.httpServer.address().port, 5173);
    assert.notEqual(viteB.httpServer.address().port, 5173);
    assert.notEqual(viteA.httpServer.address().port, viteB.httpServer.address().port);

    viteConflict = await createViteServer({ configFile: false, server: { host: '127.0.0.1', port: occupiedPort, strictPort: true, open: false } });
    await assert.rejects(new Promise((onListen, onError) => {
      viteConflict.httpServer.once('error', onError);
      viteConflict.httpServer.listen(occupiedPort, '127.0.0.1', onListen);
    }), /EADDRINUSE/u);
  } finally {
    await viteConflict?.close();
    await viteB?.close();
    await viteA?.close();
    await new Promise(resolve => blocker.close(resolve));
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
  assert.match(winCiSource, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create[^\n]*start-server/u);
  assert.doesNotMatch(winCiSource, /ci-worktree|refs\/ci\/current|"bridge-ci-api36"/u);
  assert.doesNotMatch(localCiSource, /ci-worktree/u);
});
