// Preload for validation: Node removal APIs send paths to the system recycle bin.
const fs = require('node:fs');
const INSTALLED = Symbol.for('bridge.recycleCleanupInstalled');
if (!fs[INSTALLED]) {
  fs[INSTALLED] = true;
  const { execFile, execFileSync } = require('node:child_process');
  const { promisify } = require('node:util');
  const { fileURLToPath } = require('node:url');
  const { join, resolve } = require('node:path');
  const { syncBuiltinESMExports } = require('node:module');
  const run = promisify(execFile);
  const platform = process.platform;
  const winRecycleExe = platform === 'win32' ? process.env.BRIDGE_WIN_RECYCLE_EXE : undefined;
  const staging = process.env.BRIDGE_RECYCLE_STAGING;
  let stagingDir;
  let staged = 0;
  const stagedPath = () => join(stagingDir ??= fs.mkdtempSync(join(staging, `${process.pid}-`)), String(++staged));
  const normalize = value => resolve(value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);

  function command(path) {
    if (platform === 'darwin') return ['/usr/bin/trash', [path], {}];
    if (platform === 'linux') return ['trash-put', [path], {}];
    if (platform === 'win32') {
      if (winRecycleExe) return [winRecycleExe, [path], {}];
      // SHFileOperation with FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI (0x0454)
      // moves regular files, ReadOnly items, and directories containing NTFS junctions to the Recycle Bin.
      return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; " +
        "$asm = [Microsoft.VisualBasic.FileIO.FileSystem].Assembly; " +
        "$t = $asm.GetType('Microsoft.VisualBasic.CompilerServices.NativeMethods+SHFILEOPSTRUCT'); " +
        "$m = $asm.GetType('Microsoft.VisualBasic.CompilerServices.NativeMethods').GetMethod('SHFileOperation', [Reflection.BindingFlags]'NonPublic,Static'); " +
        "$p = [Environment]::GetEnvironmentVariable('BRIDGE_RECYCLE_PATH'); " +
        "if ($p.Length -gt 3) { $p = $p.TrimEnd('\\', '/') }; " +
        "$s = [Activator]::CreateInstance($t); " +
        "$f = [Reflection.BindingFlags]'Public,NonPublic,Instance'; " +
        "$t.GetField('wFunc', $f).SetValue($s, [uint32]3); " +
        "$t.GetField('pFrom', $f).SetValue($s, $p + [char]0 + [char]0); " +
        "$t.GetField('fFlags', $f).SetValue($s, [uint16]0x0454); " +
        "$a = @($s); $rc = [int]$m.Invoke($null, $a); " +
        "$aborted = [bool]$t.GetField('fAnyOperationsAborted', $f).GetValue($a[0]); " +
        "if ($rc -ne 0 -or $aborted) { throw \"Recycle-bin SHFileOperation failed for $p (code=$rc, aborted=$aborted)\" }"],
      { env: { ...process.env, BRIDGE_RECYCLE_PATH: path } }];
    }
    throw new Error(`Trash-only cleanup is unsupported on ${platform}; nothing was deleted`);
  }

  function recycleSync(value, options = {}) {
    const path = normalize(value);
    try { fs.lstatSync(path); }
    catch (error) { if (options.force && error.code === 'ENOENT') return; throw error; }
    if (staging) {
      try { return fs.renameSync(path, stagedPath()); }
      catch (error) { if (error.code !== 'EXDEV') throw error; }
    }
    execFileSync(...command(path));
  }

  async function recycle(value, options = {}) {
    const path = normalize(value);
    try { await fs.promises.lstat(path); }
    catch (error) { if (options.force && error.code === 'ENOENT') return; throw error; }
    if (staging) {
      try { return await fs.promises.rename(path, stagedPath()); }
      catch (error) { if (error.code !== 'EXDEV') throw error; }
    }
    await run(...command(path));
  }

  for (const method of ['rm', 'unlink', 'rmdir']) {
    fs[method + 'Sync'] = recycleSync;
    fs.promises[method] = recycle;
    fs[method] = (path, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      recycle(path, options).then(() => callback(null), callback);
    };
  }
  syncBuiltinESMExports();
}
