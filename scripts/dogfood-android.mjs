// Build an origin/main snapshot on ssh win without using the distributed CI slots.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

export function buildAndroidDogfood({ revision = 'origin/main', cwd = root, exec = execFileSync } = {}) {
  const run = (command, args, stdio = 'inherit') => exec(command, args, { cwd, encoding: 'utf8', stdio });
  run('git', ['fetch', 'origin', 'main']);
  const commit = run('git', ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], 'pipe').trim();
  run('git', ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']);

  const outputRoot = join(cwd, 'output/dogfood-android');
  mkdirSync(outputRoot, { recursive: true });
  const staging = mkdtempSync(join(outputRoot, '.staging-'));
  const runId = randomUUID();
  const remote = `D:/work/bridge-android-dogfood-${runId}`;
  const host = process.env.BRIDGE_WIN_SSH_HOST ?? 'win';
  const sshOptions = ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6'];
  const powershell = source => run('ssh', [...sshOptions, host,
    `powershell.exe -NoProfile -NonInteractive -Sta -EncodedCommand ${Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${source}`, 'utf16le').toString('base64')}`]);
  const recycleSource = readFileSync(new URL('./win-recycle.cs', import.meta.url), 'utf8');
  let result;
  console.log(`Android dogfood commit: ${commit}\nWindows staging: ${remote}`);
  try {
    run('git', ['archive', '--format=zip', `--output=${join(staging, 'source.zip')}`, commit]);
    powershell(`New-Item -ItemType Directory -Path '${remote}' | Out-Null`);
    run('scp', ['-q', ...sshOptions, join(staging, 'source.zip'),
      fileURLToPath(new URL('./win-dogfood-android.ps1', import.meta.url)), `${host}:${remote}/`]);
    powershell(`& '${remote}/win-dogfood-android.ps1'`);
    run('scp', ['-q', ...sshOptions, `${host}:${remote}/app-debug.apk`, `${host}:${remote}/sha256.txt`, staging]);
    const sha256 = createHash('sha256').update(readFileSync(join(staging, 'app-debug.apk'))).digest('hex');
    if (sha256 !== readFileSync(join(staging, 'sha256.txt'), 'utf8').trim()) {
      throw new Error('APK SHA-256 differs from the Windows build; refusing to keep the copy.');
    }
    const directory = join(outputRoot, `${commit.slice(0, 12)}-${runId}`);
    mkdirSync(directory);
    const apk = join(directory, `Bridge-Android-${commit.slice(0, 12)}-debug.apk`);
    copyFileSync(join(staging, 'app-debug.apk'), apk);
    result = { commit, apk, sha256 };
  } finally {
    try {
      // Inline the existing native recycler so cleanup also works after an incomplete upload.
      powershell(`if (Test-Path -LiteralPath '${remote}') {
        $types = Add-Type -TypeDefinition @'
${recycleSource}
'@ -PassThru -WarningAction SilentlyContinue
        $code = ($types | Where-Object Name -eq 'Program').GetMethod('Main', [Reflection.BindingFlags]'NonPublic,Static').Invoke($null, (, [string[]]@('${remote}')))
        if ($code -ne 0) { throw 'Windows dogfood staging recycle failed: ${remote}' }
      }`);
    } finally {
      run('/usr/bin/trash', [staging]);
    }
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
  if (process.platform !== 'darwin') throw new Error('Run dogfood-android on the Mac; it builds through ssh win.');
  if (process.argv.length > 3) throw new Error('Usage: node scripts/dogfood-android.mjs [main-commit]');
  buildAndroidDogfood({ revision: process.argv[2] ?? 'origin/main' });
}
