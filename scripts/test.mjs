import { spawn } from 'node:child_process';
import { createWriteStream, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { recycleEnv } from './ci-run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = [
  ['desktop', 'apps/desktop'],
  ['client', 'apps/client'],
  ['protocol', 'packages/protocol'],
  ['relay', 'apps/relay'],
  ['quota', 'plugins/magpie-quota'],
].map(([name, path]) => ({
  name,
  cwd: resolve(root, path),
  command: process.execPath,
  args: [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=4', '--reporter=default', '--reporter=junit'],
}));

// Suite commands accept Vitest's outputFile.junit flag, also used by the infrastructure fixtures.
export async function runSuites(entries, output = resolve(root, 'artifacts/tests')) {
  await mkdir(output, { recursive: true });
  const env = recycleEnv();
  for (const key of Object.keys(env)) if (key.startsWith('VITE_')) delete env[key];
  const stageRoot = env.BRIDGE_RECYCLE_STAGING ? undefined : await mkdtemp(join(tmpdir(), 'bridge-test-recycle-'));
  if (stageRoot) env.BRIDGE_RECYCLE_STAGING = stageRoot;
  const results = new Array(entries.length);
  let nextIndex = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(2, entries.length) }, async () => {
      while (nextIndex < entries.length) {
        const index = nextIndex++;
        const suite = entries[index];
        const junit = resolve(output, `${suite.name}.xml`);
        const logPath = resolve(output, `${suite.name}.log`);
        await rm(junit, { force: true });
        const log = createWriteStream(logPath);
        const errors = [];
        console.log(`\n=== ${suite.name} ===`);
        const exitCode = await new Promise(resolveExit => {
          const child = spawn(suite.command, [...suite.args, `--outputFile.junit=${junit}`], {
            cwd: suite.cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
          });
          child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
          child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
          child.on('error', error => errors.push(error.message));
          child.on('close', (code, signal) => {
            if (signal) errors.push(`Terminated by ${signal}`);
            resolveExit(code ?? 1);
          });
        });
        if (exitCode !== 0) errors.push(`Suite exited with code ${exitCode}`);
        if (!(await stat(junit).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        }))?.size) errors.push('JUnit report is missing or empty');
        for (const error of errors) {
          console.error(`${suite.name}: ${error}`);
          log.write(`${suite.name}: ${error}\n`);
        }
        await new Promise((resolveLog, rejectLog) => {
          log.on('error', rejectLog);
          log.end(resolveLog);
        });
        results[index] = { suite: suite.name, exitCode, passed: errors.length === 0, errors, junit, log: logPath };
      }
    }));
    await writeFile(resolve(output, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`);
    return results.every(result => result.passed) ? 0 : 1;
  } finally {
    if (stageRoot) await rm(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSuites(suites);
}
