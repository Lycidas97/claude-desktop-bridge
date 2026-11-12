import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm as recycle, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

createRequire(import.meta.url)('./recycle-cleanup.cjs');

const ci = (await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
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
      await recycle(directory, { recursive: true, force: true });
    }
  });
}

test('online CI workflow is manual fallback only and never auto-runs on PRs or pushes', () => {
  assert.match(ci, /^name: CI\n\non:\n  workflow_dispatch:\n\npermissions:/u);
  assert.doesNotMatch(ci, /\n  push:/u);
  assert.doesNotMatch(ci, /\n  pull_request:/u);
  assert.match(
    ci,
    /concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.head_ref \|\| github\.ref_name \}\}\n  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u,
  );
  assert.doesNotMatch(ci, /cancel-in-progress:\s*true/u);
});

test('release automation triggers on main ci/local-distributed status or manual CI and sends its immutable revision', () => {
  assert.match(release, /\non:\n  status:\n  workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]\n    branches: \[main\]\n  workflow_dispatch:/u);
  assert.match(release, /statuses: read/u);
  assert.match(assets, /statuses: read/u);
  assert.match(release, /github\.event\.context == 'ci\/local-distributed'/u);
  assert.match(release, /github\.event\.state == 'success'/u);
  assert.match(release, /contains\(github\.event\.branches\.\*\.name, 'main'\)/u);
  assert.match(release, /workflow_run\.conclusion == 'success'/u);
  assert.match(release, /\(github\.event\.workflow_run\.event == 'push' \|\| github\.event\.workflow_run\.event == 'workflow_dispatch'\)/u);
  assert.match(release, /workflow_run\.head_repository\.full_name == github\.repository/u);
  assert.match(release, /RELEASE_REVISION: \$\{\{ github\.event\.sha \|\| github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/u);
  const retryGate = shellStep(release, 'Require verified CI for release revision');
  assert.match(retryGate, /git merge-base --is-ancestor "\$RELEASE_REVISION" refs\/remotes\/origin\/main/u);
  assert.match(retryGate, /commits\/\$1\/status\?per_page=100/u);
  assert.match(retryGate, /\.context == "ci\/local-distributed" and \.state == "success"/u);
  assert.match(retryGate, /--repo "\$GITHUB_REPOSITORY" --workflow ci\.yml/u);
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
  assert.match(source, /git merge-base --is-ancestor "\$REVISION" refs\/remotes\/origin\/main/u);
  assert.match(source, /commits\/\$1\/status\?per_page=100/u);
  assert.match(source, /\.context == "ci\/local-distributed" and \.state == "success"/u);
  assert.match(source, /--repo "\$GITHUB_REPOSITORY" --workflow ci\.yml/u);
  assert.match(source, /"\$TAG" == "v\$\(jq -er '\.version' package\.json\)"/u);
  assert.match(shellStep(assets, 'Generate release notes'), /git tag --merged "\$RELEASE_REVISION"/u);
  assert.doesNotMatch(shellStep(assets, 'Publish GitHub Release with platform assets'), /\$GITHUB_SHA/u);
  assert.match(shellStep(assets, 'Publish GitHub Release with platform assets'), /--target "\$RELEASE_REVISION"/u);
  assert.match(shellStep(assets, 'Stage platform assets'), /sha256sum Bridge-\* > SHA256SUMS\.txt/u);
});

test('release and release-assets CI gates enforce main ancestry and accept exact-SHA local status or completed main CI', {
  skip: process.platform === 'win32', // Production gate jobs run on Ubuntu with bash + jq.
}, async () => {
  const targetSha = 'a'.repeat(40);
  const otherSha = 'b'.repeat(40);
  const directory = await mkdtemp(join(tmpdir(), 'bridge-ci-gate-'));
  try {
    const callsLog = join(directory, 'gh-calls.jsonl');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '1.3.2' }));
    await writeFile(
      join(directory, 'git'),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') {
  console.log(${JSON.stringify(targetSha)});
  process.exit(0);
}
if (args[0] === 'fetch') {
  process.exit(0);
}
if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
  process.exit(process.env.MOCK_IS_ANCESTOR === 'false' ? 1 : 0);
}
process.exit(2);
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(directory, 'gh'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  if (process.env.MOCK_GH_STATUS_EXIT === '1') process.exit(1);
  process.stdout.write(process.env.MOCK_GH_STATUS ?? JSON.stringify({ sha: '', statuses: [] }));
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'list') {
  process.stdout.write(process.env.MOCK_GH_RUNS ?? '[]');
  process.exit(0);
}
process.exit(2);
`,
      { mode: 0o755 },
    );

    const cases = [
      {
        label: 'ci/local-distributed success on exact main SHA',
        isAncestor: true,
        statusPayload: { sha: targetSha, statuses: [{ context: 'ci/local-distributed', state: 'success' }] },
        runs: [],
        expectPass: true,
        expectShortCircuit: true,
      },
      {
        label: 'ci/local-distributed success rejected when SHA is not on main',
        isAncestor: false,
        statusPayload: { sha: targetSha, statuses: [{ context: 'ci/local-distributed', state: 'success' }] },
        runs: [],
        expectPass: false,
      },
      {
        label: 'ci/local-distributed failure rejected without fallback CI',
        isAncestor: true,
        statusPayload: { sha: targetSha, statuses: [{ context: 'ci/local-distributed', state: 'failure' }] },
        runs: [],
        expectPass: false,
      },
      {
        label: 'ci/local-distributed mismatched status SHA rejected',
        isAncestor: true,
        statusPayload: { sha: otherSha, statuses: [{ context: 'ci/local-distributed', state: 'success' }] },
        runs: [],
        expectPass: false,
      },
      {
        label: 'fallback manual workflow_dispatch CI completed+success for target SHA',
        isAncestor: true,
        statusPayload: { sha: targetSha, statuses: [] },
        runs: [{ headSha: targetSha, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }],
        expectPass: true,
      },
      {
        label: 'fallback push CI completed+success for target SHA',
        isAncestor: true,
        statusExit: '1',
        runs: [{ headSha: targetSha, event: 'push', status: 'completed', conclusion: 'success' }],
        expectPass: true,
      },
      {
        label: 'pull_request CI run on fork named main rejected',
        isAncestor: true,
        statusPayload: { sha: targetSha, statuses: [] },
        runs: [{ headSha: targetSha, event: 'pull_request', status: 'completed', conclusion: 'success' }],
        expectPass: false,
      },
      {
        label: 'mismatched headSha in CI runs rejected',
        isAncestor: true,
        statusPayload: { sha: targetSha, statuses: [] },
        runs: [{ headSha: otherSha, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }],
        expectPass: false,
      },
      {
        label: 'in_progress CI run rejected',
        isAncestor: true,
        statusPayload: { sha: targetSha, statuses: [] },
        runs: [{ headSha: targetSha, event: 'workflow_dispatch', status: 'in_progress', conclusion: 'success' }],
        expectPass: false,
      },
      {
        label: 'cancelled CI run rejected',
        isAncestor: true,
        statusPayload: { sha: targetSha, statuses: [] },
        runs: [{ headSha: targetSha, event: 'workflow_dispatch', status: 'completed', conclusion: 'cancelled' }],
        expectPass: false,
      },
    ];

    const releaseGate = shellStep(release, 'Require verified CI for release revision');
    const assetsGate = shellStep(assets, 'Resolve source and require successful CI before publication');

    for (const c of cases) {
      const output = join(directory, 'github-output');
      await writeFile(output, '');
      await writeFile(callsLog, '');
      const baseEnv = {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'fixture/bridge',
        MOCK_IS_ANCESTOR: String(c.isAncestor),
        MOCK_GH_STATUS_EXIT: c.statusExit ?? '0',
        MOCK_GH_STATUS: JSON.stringify(c.statusPayload ?? { sha: '', statuses: [] }),
        MOCK_GH_RUNS: JSON.stringify(c.runs),
      };

      const releaseResult = spawnSync('bash', ['-c', releaseGate], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...baseEnv, RELEASE_REVISION: targetSha },
      });
      if (c.expectPass) {
        assert.equal(releaseResult.status, 0, `release.yml gate failed (${c.label}): ${releaseResult.stderr}`);
        if (c.expectShortCircuit) {
          const calls = (await readFile(callsLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
          assert.deepEqual(calls, [['api', `repos/fixture/bridge/commits/${targetSha}/status?per_page=100`]]);
        }
      } else {
        assert.notEqual(releaseResult.status, 0, `release.yml gate unexpectedly passed (${c.label})`);
      }

      const assetsResult = spawnSync('bash', ['-c', assetsGate], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...baseEnv,
          GITHUB_OUTPUT: output,
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          TAG: 'v1.3.2',
          REQUESTED_REVISION: targetSha,
        },
      });
      if (c.expectPass) {
        assert.equal(assetsResult.status, 0, `release-assets.yml gate failed (${c.label}): ${assetsResult.stderr}`);
        assert.equal(await readFile(output, 'utf8'), `revision=${targetSha}\n`);
      } else {
        assert.notEqual(assetsResult.status, 0, `release-assets.yml gate unexpectedly passed (${c.label})`);
      }
    }
  } finally {
    await recycle(directory, { recursive: true, force: true });
  }
});

test('CI Quality gate enforces full 8-job success on manual dispatch', {
  skip: process.platform === 'win32',
}, () => {
  const gateScript = shellStep(ci, 'Require every job to succeed');
  const allSuccess = {
    changes: { result: 'success' },
    verify: { result: 'success' },
    'desktop-windows': { result: 'success' },
    'desktop-linux': { result: 'success' },
    'android-debug': { result: 'success' },
    ios: { result: 'success' },
    'macos-unit': { result: 'success' },
    'browser-e2e': { result: 'success' },
  };
  const skippedPlatform = {
    ...allSuccess,
    'desktop-windows': { result: 'skipped' },
  };

  const cases = [
    { label: 'workflow_dispatch all success', env: { EVENT_NAME: 'workflow_dispatch', DOCS_ONLY: 'false', IOS_CHANGED: 'true', JOB_RESULTS: JSON.stringify(allSuccess) }, pass: true },
    { label: 'workflow_dispatch rejects skipped platform job', env: { EVENT_NAME: 'workflow_dispatch', DOCS_ONLY: 'false', IOS_CHANGED: 'false', JOB_RESULTS: JSON.stringify(skippedPlatform) }, pass: false },
    { label: 'workflow_dispatch rejects cancelled job', env: { EVENT_NAME: 'workflow_dispatch', DOCS_ONLY: 'false', IOS_CHANGED: 'true', JOB_RESULTS: JSON.stringify({ ...allSuccess, ios: { result: 'cancelled' } }) }, pass: false },
  ];

  for (const { label, env, pass } of cases) {
    const result = spawnSync('bash', ['-c', gateScript], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    if (pass) assert.equal(result.status, 0, `Expected pass (${label}): ${result.stderr}`);
    else assert.notEqual(result.status, 0, `Expected failure (${label})`);
  }
});
