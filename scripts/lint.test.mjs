import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const lint = fileURLToPath(new URL('./lint.mjs', import.meta.url));

test('blocks prototype-only DesktopController fixtures in Desktop tests and the Native browser fixture', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-lint-'));
  for (const [path, code] of [
    ['apps/desktop/src/controller/controller-commands.test.ts',
      'const controller = Object.assign(Object.create(DesktopController.prototype), { broker });'],
    ['apps/desktop/scripts/example.test.mjs', 'Object.create(DesktopController.prototype);'],
    ['scripts/fixtures/native-approval-host.ts', 'Object.create(\n  DesktopController.prototype,\n);'],
  ]) {
    mkdirSync(join(cwd, dirname(path)), { recursive: true });
    writeFileSync(join(cwd, path), code);
  }
  const result = spawnSync(process.execPath, [lint], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.stderr.trim().replaceAll('\\', '/').split(/\r?\n/u), [
    'apps/desktop/scripts/example.test.mjs:1:1 [desktop/controller-real-constructor] Use createControllerFixture(...) to run the real DesktopController constructor.',
    'apps/desktop/src/controller/controller-commands.test.ts:1:34 [desktop/controller-real-constructor] Use createControllerFixture(...) to run the real DesktopController constructor.',
    'scripts/fixtures/native-approval-host.ts:1:1 [desktop/controller-real-constructor] Use createControllerFixture(...) to run the real DesktopController constructor.',
  ]);
});

test('allows real constructors, unrelated calls, quoted text and files outside the rule scope', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-lint-'));
  for (const [path, code] of [
    ['apps/desktop/src/controller/controller.test.ts', `
      const fixture = createControllerFixture({});
      const controller = new DesktopController(...args);
      const keymap = Object.create(null);
      const bridge = Object.create(ClaudeDesktopBridge.prototype);
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
  assert.equal(result.stderr, '');
});
