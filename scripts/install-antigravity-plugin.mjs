#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    'repo-root': { type: 'string' },
    node: { type: 'string' },
    'owner-config': { type: 'string' },
    'worker-config': { type: 'string' },
    'allow-owner-mcp': { type: 'boolean', default: false },
    demo: { type: 'boolean', default: false },
    tools: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(
    [
      'Usage: node scripts/install-antigravity-plugin.mjs [options]',
      '',
      'Equivalent to: sift connect antigravity [options]',
      '',
      'Options:',
      '  --target <dir>          Plugin install directory (default: ~/.gemini/config/plugins/siftable-graph)',
      '  --repo-root <path>      Override Siftable repository root (default: this checkout)',
      '  --node <path>           Absolute Node.js >=22 binary path (default: current node)',
      '  --owner-config <path>   Credential file for Sidecar UI (default: <repo>/.local/owner.json)',
      '  --worker-config <path>  Scoped agent credential file for MCP (default: <repo>/.local/worker.json)',
      '  --allow-owner-mcp       Wire MCP to owner-config when worker-config does not exist yet',
      '  --demo                  Force interactive demo mode in the Graph sidecar',
      '  --tools <csv>           SIFT_TOOLS filter (default: projects,context,work,planning,extensions)',
      '  --dry-run               Print planned operations without writing files',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const repoRoot = resolve(
  values['repo-root'] ?? join(dirname(fileURLToPath(import.meta.url)), '..'),
);
const graphServerEntry = join(repoRoot, 'apps', 'graph-ui', 'dist', 'server.js');
const mcpEntry = join(repoRoot, 'packages', 'mcp', 'dist', 'index.js');
const connectEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'cli',
  'dist',
  'connect.js',
);

const missing = [graphServerEntry, mcpEntry, connectEntry].filter((p) => !existsSync(p));
if (missing.length > 0) {
  process.stderr.write(
    JSON.stringify({
      error: 'Build artifacts missing; run `npm run build` before installing the plugin.',
      missing,
    }) + '\n',
  );
  process.exit(1);
}

const { runConnect } = await import(pathToFileURL(connectEntry).href);

try {
  const result = await runConnect({
    harness: 'antigravity',
    dryRun: Boolean(values['dry-run']),
    target: values.target,
    repoRoot,
    node: values.node,
    ownerConfig: values['owner-config'],
    workerConfig: values['worker-config'],
    allowOwnerMcp: Boolean(values['allow-owner-mcp']),
    demo: Boolean(values.demo),
    tools: values.tools,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (err) {
  const payload = {
    error: err instanceof Error ? err.message : String(err),
    ...(err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
      ? { code: err.code }
      : {}),
    ...(err && typeof err === 'object' && 'suggestions' in err && Array.isArray(err.suggestions)
      ? { suggestions: err.suggestions }
      : {}),
  };
  process.stderr.write(JSON.stringify(payload) + '\n');
  process.exit(1);
}
