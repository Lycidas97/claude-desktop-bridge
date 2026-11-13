import './recycle-cleanup.cjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function recycleEnv(env = process.env) {
  const preload = fileURLToPath(new URL('./recycle-cleanup.cjs', import.meta.url));
  return { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim() };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const npm = (...args) => [process.execPath, [process.env.npm_execpath, ...args]];
  const commands = mode === 'verify'
    ? [npm('run', 'typecheck'), npm('test'), npm('run', 'build')]
    : mode === 'browser'
      ? [npm('run', 'build', '-w', '@bridge/protocol'), npm('run', 'build', '-w', '@bridge/relay'),
        [process.execPath, ['scripts/browser-e2e.mjs']]]
      : mode === 'browser:nobuild'
        ? [[process.execPath, ['scripts/browser-e2e.mjs']]]
        : mode === 'npm' ? [npm(...process.argv.slice(3))] : null;

  if (!commands || (mode !== 'browser:nobuild' && !process.env.npm_execpath)) {
    console.error('Use npm run verify, npm run test:browser, or npm run ci:run -- <npm arguments>');
    process.exitCode = 1;
  } else {
    for (const [command, args] of commands) {
      const result = spawnSync(command, args, { cwd: root, env: recycleEnv(), stdio: 'inherit' });
      if (result.error) console.error(result.error);
      if (result.error || result.status !== 0) {
        process.exitCode = result.status || 1;
        break;
      }
    }
  }
}
