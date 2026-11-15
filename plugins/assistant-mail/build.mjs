import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export function buildMailMcp(outfile = fileURLToPath(new URL('./dist/mcp.cjs', import.meta.url))) {
  return build({
    entryPoints: [fileURLToPath(new URL('./mcp-entry.ts', import.meta.url))],
    outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildMailMcp();
