// Preload for validation: Node removal APIs send paths to the system recycle bin.
const fs = require('node:fs');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { fileURLToPath } = require('node:url');
const { resolve } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const run = promisify(execFile);
const platform = process.platform;
const normalize = value => resolve(value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);

function command(path, directory) {
  if (platform === 'darwin') return ['/usr/bin/trash', [path], {}];
  if (platform === 'linux') return ['trash-put', [path], {}];
  if (platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; " +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::Delete${directory ? 'Directory' : 'File'}(` +
      "[Environment]::GetEnvironmentVariable('BRIDGE_RECYCLE_PATH'), 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')"],
    { env: { ...process.env, BRIDGE_RECYCLE_PATH: path } }];
  }
  throw new Error(`Trash-only cleanup is unsupported on ${platform}; nothing was deleted`);
}

function recycleSync(value, options = {}) {
  const path = normalize(value);
  let stat;
  try { stat = fs.lstatSync(path); }
  catch (error) { if (options.force && error.code === 'ENOENT') return; throw error; }
  execFileSync(...command(path, stat.isDirectory()));
}

async function recycle(value, options = {}) {
  const path = normalize(value);
  let stat;
  try { stat = await fs.promises.lstat(path); }
  catch (error) { if (options.force && error.code === 'ENOENT') return; throw error; }
  await run(...command(path, stat.isDirectory()));
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
