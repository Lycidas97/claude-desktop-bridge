// Opt-in real ssh win check: hold a file, interrupt the build, then verify worker-tree and staging cleanup.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAndroidDogfood } from './dogfood-android.mjs';

createRequire(import.meta.url)('./recycle-cleanup.cjs');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'bridge-dogfood-interruption-'));
const fixture = join(fixtureRoot, 'win-dogfood-android.ps1');
writeFileSync(fixture, `$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'worker.pid'), [string]$PID)
$stream = [IO.File]::Open((Join-Path $PSScriptRoot 'held.txt'), [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$descendant = Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 45' -PassThru
try {
  Write-Output "HELD_WORKER=$PID CHILD=$($descendant.Id)"
  Start-Sleep -Seconds 45
} finally { $stream.Dispose() }
`);

try {
  for (const mode of ['SIGINT', 'SSH_EXIT']) {
    let remote;
    let staging;
    let workerPid;
    let descendantPid;
    await assert.rejects(buildAndroidDogfood({
      revision: process.argv[2] ?? 'origin/main',
      exec(command, args, options) {
        if (command === 'scp') args = args.map(arg => arg.endsWith('/win-dogfood-android.ps1') ? fixture : arg);
        if (command === '/usr/bin/trash') staging = args[0];
        if (command === 'ssh' && args.at(-1).includes('-File')) {
          remote = /"(D:\/work\/bridge-android-dogfood-[^/]+)\/win-dogfood-android\.ps1"/.exec(args.at(-1))[1];
          return new Promise((resolve, reject) => {
            const child = spawn(command, args, { cwd: options.cwd, signal: options.signal, stdio: ['ignore', 'pipe', 'pipe'] });
            let error;
            let output = '';
            child.on('error', value => { error = value; });
            child.stderr.on('data', chunk => process.stderr.write(chunk));
            child.stdout.on('data', chunk => {
              output += chunk;
              const match = /HELD_WORKER=(\d+) CHILD=(\d+)/.exec(output);
              if (match && !workerPid) {
                workerPid = Number(match[1]);
                descendantPid = Number(match[2]);
                if (mode === 'SIGINT') process.kill(process.pid, 'SIGINT');
                else child.kill('SIGKILL');
              }
            });
            child.on('close', (code, signal) => code === 0 ? resolve('') : reject(error ?? new Error(`fixture SSH exited ${signal ?? code}`)));
          });
        }
        return execFileSync(command, args, options);
      },
    }), mode === 'SIGINT' ? { name: 'AbortError' } : /fixture SSH exited SIGKILL/);
    assert.ok(workerPid && descendantPid);
    assert.equal(existsSync(staging), false);
    const check = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';
      if (Get-Process -Id ${workerPid},${descendantPid} -ErrorAction SilentlyContinue) { throw 'Owned worker tree survived' }
      if (Test-Path -LiteralPath '${remote}') { throw 'Staging survived' }
      Write-Output 'PASS ${mode}: owned worker + descendant stopped; Windows and Mac staging recycled'`;
    execFileSync('ssh', [process.env.BRIDGE_WIN_SSH_HOST ?? 'win',
      `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(check, 'utf16le').toString('base64')}`], { stdio: 'inherit' });
  }
} finally {
  rmSync(fixtureRoot, { recursive: true });
}
