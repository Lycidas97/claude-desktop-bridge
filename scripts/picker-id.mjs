// Resolves a Claude Desktop model-picker id from the label Magpie gives a model or routing group.
// Picker ids are generated per machine by Claude Desktop, so they are looked up here instead of being written down.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function configLibraryDir(platform = process.platform, env = process.env) {
  if (env.CLAUDE_CONFIG_LIBRARY) return env.CLAUDE_CONFIG_LIBRARY;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude-3p', 'configLibrary');
  if (platform === 'win32') return join(env.LOCALAPPDATA, 'Claude-3p', 'configLibrary');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude-3p', 'configLibrary');
}

// A routing group is labelled "<group name> · routing group"; a single model "<model name> · <provider name>".
export function resolvePickerId(dir, label) {
  const models = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')).inferenceModels ?? []);
  const matches = models.filter((model) => model.labelOverride === label || model.labelOverride?.startsWith(`${label} · `));
  if (matches.length !== 1) {
    const found = matches.length ? `matches ${matches.map((model) => model.labelOverride).join(', ')}` : 'is not in the model list';
    throw new Error(`"${label}" ${found} (${dir}). A group added in Magpie appears after Claude Desktop restarts.`);
  }
  return matches[0].name;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const label = process.argv.slice(2).join(' ');
  if (!label) {
    console.error('Usage: node scripts/picker-id.mjs <group name | "Model · Provider">');
    process.exitCode = 1;
  } else {
    console.log(resolvePickerId(configLibraryDir(), label));
  }
}
