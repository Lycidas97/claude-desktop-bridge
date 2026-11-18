import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const lint = fileURLToPath(new URL('./lint.mjs', import.meta.url));

function lintDiagnostics(stderr) {
  return stderr.split(/\r?\n/u)
    .filter(line => /:\d+:\d+ \[[a-z-]+\/[a-z-]+\] /u.test(line))
    .map(line => line.replaceAll('\\', '/'));
}

test('blocks prototype-only Desktop fixtures in Desktop tests and the Native browser fixture', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-lint-'));
  for (const [path, code] of [
    ['apps/desktop/src/controller/controller-commands.test.ts',
      'const controller = Object.assign(Object.create(DesktopController.prototype), { broker });'],
    ['apps/desktop/scripts/example.test.mjs', 'Object.create(DesktopController.prototype);\nObject.create(ClaudeDesktopBridge.prototype);'],
    ['scripts/fixtures/native-approval-host.ts', 'Object.create(\n  DesktopController.prototype,\n);'],
  ]) {
    mkdirSync(join(cwd, dirname(path)), { recursive: true });
    writeFileSync(join(cwd, path), code);
  }
  const result = spawnSync(process.execPath, [lint], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(lintDiagnostics(result.stderr), [
    'apps/desktop/scripts/example.test.mjs:1:1 [desktop/controller-real-constructor] Use createControllerFixture(...) to run the real DesktopController constructor.',
    'apps/desktop/src/controller/controller-commands.test.ts:1:34 [desktop/controller-real-constructor] Use createControllerFixture(...) to run the real DesktopController constructor.',
    'scripts/fixtures/native-approval-host.ts:1:1 [desktop/controller-real-constructor] Use createControllerFixture(...) to run the real DesktopController constructor.',
    'apps/desktop/scripts/example.test.mjs:2:1 [desktop/claude-bridge-real-constructor] Use new ClaudeDesktopBridge(...) with test dependencies to run the real constructor.',
  ]);
});

test('allows real constructors, unrelated calls, quoted text and files outside the rule scope', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-lint-'));
  for (const [path, code] of [
    ['apps/desktop/src/controller/controller.test.ts', `
      const fixture = createControllerFixture({});
      const controller = new DesktopController(...args);
      const keymap = Object.create(null);
      const bridge = new ClaudeDesktopBridge(options);
      // Object.create(DesktopController.prototype)
      const example = 'Object.create(DesktopController.prototype)';
    `],
    ['apps/client/src/example.test.ts', 'Object.create(DesktopController.prototype);'],
  ]) {
    mkdirSync(join(cwd, dirname(path)), { recursive: true });
    writeFileSync(join(cwd, path), code);
  }
  const result = spawnSync(process.execPath, [lint], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lintDiagnostics(result.stderr), []);
});


test('requires protocol source in the pre-build relay probe', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-lint-'));
  mkdirSync(join(cwd, 'scripts'));
  const probe = join(cwd, 'scripts/relay-contract-probe.mjs');
  writeFileSync(probe, `
import { PROTOCOL_VERSION } from '@bridge/protocol';
await import('../packages/protocol/dist/index.js');
require('@bridge/protocol');
export * from '@bridge/protocol';
`);
  writeFileSync(join(cwd, 'scripts/browser-e2e.mjs'), `import '../packages/protocol/dist/index.js';`);
  const rejected = spawnSync(process.execPath, [lint], { cwd, encoding: 'utf8' });
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.deepEqual(lintDiagnostics(rejected.stderr), [
    'scripts/relay-contract-probe.mjs:2:1 [ci/prebuild-protocol-source] Import from packages/protocol/src in this pre-build script.',
    'scripts/relay-contract-probe.mjs:3:7 [ci/prebuild-protocol-source] Import from packages/protocol/src in this pre-build script.',
    'scripts/relay-contract-probe.mjs:4:1 [ci/prebuild-protocol-source] Import from packages/protocol/src in this pre-build script.',
    'scripts/relay-contract-probe.mjs:5:1 [ci/prebuild-protocol-source] Import from packages/protocol/src in this pre-build script.',
  ]);
  writeFileSync(probe, `import { PROTOCOL_VERSION } from '../packages/protocol/src/types.ts';`);
  const accepted = spawnSync(process.execPath, [lint], { cwd, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(lintDiagnostics(accepted.stderr), []);
});
