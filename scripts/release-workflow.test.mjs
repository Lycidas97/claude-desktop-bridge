import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const release = (await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
const assets = (await readFile(new URL('../.github/workflows/release-assets.yml', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');

function shellStep(workflow, name) {
  const lines = workflow.split(`- name: ${name}\n`)[1].split('        run: |\n')[1].split('\n');
  const end = lines.findIndex(line => line.trim() && !line.startsWith('          '));
  return lines.slice(0, end < 0 ? undefined : end).map(line => line.slice(10)).join('\n');
}

// Execute the workflow's actual decision script against disposable local stubs.
// GitHub is never mutated and no build or release is started by these tests.
for (const state of ['missing', 'draft', 'published']) {
  test(`release decision ${state === 'published' ? 'skips published versions' : `resumes ${state} releases`}`, {
    skip: process.platform === 'win32', // The production decision job runs on Ubuntu.
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-release-'));
    try {
      await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '1.3.0' }));
      await writeFile(join(directory, 'gh'), `#!${process.execPath}\nif (process.env.RELEASE_STATE === 'missing') process.exit(1); console.log(process.env.RELEASE_STATE === 'draft');\n`, { mode: 0o755 });
      const output = join(directory, 'output');
      const result = spawnSync('bash', ['-c', shellStep(release, 'Inspect release version')], {
        cwd: directory, encoding: 'utf8', env: {
          ...process.env, PATH: `${directory}:${process.env.PATH}`,
          RELEASE_STATE: state, GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: 'fixture/bridge', RELEASE_REVISION: 'a'.repeat(40),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(await readFile(output, 'utf8'), new RegExp(`version=1.3.0\\nshould_release=${state !== 'published'}\\n`));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('release automation waits for full main CI and sends its immutable revision', () => {
  assert.match(release, /workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]\n    branches: \[main\]/u);
  assert.match(release, /workflow_run\.conclusion == 'success'/u);
  assert.match(release, /workflow_run\.event == 'push'/u);
  assert.match(release, /workflow_run\.head_repository\.full_name == github\.repository/u);
  assert.match(release, /RELEASE_REVISION: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/u);
  assert.match(shellStep(release, 'Require successful CI for manual retry'), /--commit "\$RELEASE_REVISION" --event push --status success/u);
  assert.match(shellStep(release, 'Dispatch platform asset builds for the verified revision'), /--ref main -f "tag=v\$\{VERSION\}" -f "revision=\$RELEASE_REVISION"/u);
  assert.match(shellStep(release, 'Create or resume draft GitHub Release'), /gh release edit[\s\S]*--target "\$RELEASE_REVISION"/u);
});

test('every platform and publisher uses the same resolved source; all platforms must finish', () => {
  assert.match(assets, /ref: \$\{\{ inputs\.revision \|\| github\.sha \}\}/u);
  for (const job of ['desktop', 'android', 'ios', 'publish']) {
    const section = assets.split(`\n  ${job}:\n`)[1].split(/\n  [a-z]+:\n/u)[0];
    assert.match(section, /needs: (source|\[source, desktop, android, ios\])/u);
    assert.match(section, /ref: \$\{\{ needs\.source\.outputs\.revision \}\}/u);
  }
  const source = shellStep(assets, 'Resolve source and require successful CI before publication');
  assert.match(source, /"\$REQUESTED_REVISION" != "\$REVISION"/u);
  assert.match(source, /--commit "\$REVISION" --event push --status success/u);
  assert.match(source, /"\$TAG" == "v\$\(jq -er '\.version' package\.json\)"/u);
  assert.match(shellStep(assets, 'Generate release notes'), /git tag --merged "\$RELEASE_REVISION"/u);
  assert.doesNotMatch(shellStep(assets, 'Publish GitHub Release with platform assets'), /\$GITHUB_SHA/u);
  assert.match(shellStep(assets, 'Publish GitHub Release with platform assets'), /--target "\$RELEASE_REVISION"/u);
  assert.match(shellStep(assets, 'Stage platform assets'), /sha256sum Bridge-\* > SHA256SUMS\.txt/u);
});
