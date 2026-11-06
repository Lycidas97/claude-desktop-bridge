import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { runSuites } from './test.mjs';
import { recycleEnv } from './ci-run.mjs';

const require = createRequire(import.meta.url);
const preload = await readFile(new URL('./recycle-cleanup.cjs', import.meta.url), 'utf8');

function mockCleanup(platform, { missing = false, failure = false, directory = false } = {}) {
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
  vm.runInNewContext(preload, {
    Buffer, URL, process: { platform, env: { PRESERVE_ME: 'yes' } },
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
  return { fs: mockFs, calls };
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
      await mock.fs.promises[method](new URL('file:///tmp/a%20fixture'));
      await new Promise((resolve, reject) => mock.fs[method]('a fixture', error => error ? reject(error) : resolve()));
    }
    assert.equal(mock.calls.length, 9);
    assert.ok(mock.calls.every(call => call[0] === (platform === 'darwin' ? '/usr/bin/trash' : platform === 'linux' ? 'trash-put' : 'powershell.exe')));
    if (platform === 'win32') {
      assert.equal(mock.calls[0][2].env.PRESERVE_ME, 'yes');
      assert.match(mock.calls[0][1].at(-1), /DeleteFile.*SendToRecycleBin/);
      assert.ok(!mock.calls[0][1].at(-1).includes('a fixture'));
      const dir = mockCleanup(platform, { directory: true });
      dir.fs.rmSync('directory', { recursive: true });
      assert.match(dir.calls[0][1].at(-1), /DeleteDirectory/);
    }
  });
}

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

test('real system recycle command removes a disposable fixture from its original path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge recycle-'));
  try {
    const fixture = join(directory, 'disposable.txt');
    await writeFile(fixture, 'infrastructure fixture');
    const result = spawnSync(process.execPath, ['-e', `require('node:fs').unlinkSync(process.argv[1])`, fixture], {
      env: recycleEnv(), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(fixture), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
