#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    node: { type: 'string' },
    'owner-config': { type: 'string' },
    'worker-config': { type: 'string' },
    'allow-owner-mcp': { type: 'boolean', default: false },
    demo: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(
    [
      'Usage: node scripts/install-antigravity-plugin.mjs [options]',
      '',
      'Options:',
      '  --target <dir>          Plugin install directory (default: ~/.gemini/config/plugins/siftable-graph)',
      '  --node <path>           Absolute Node.js >=22 binary path (default: current node)',
      '  --owner-config <path>   Credential file for Sidecar UI (default: <repo>/.local/owner.json)',
      '  --worker-config <path>  Scoped agent credential file for MCP (default: <repo>/.local/worker.json)',
      '  --allow-owner-mcp       Wire MCP to owner-config when worker-config does not exist yet',
      '  --demo                  Force interactive demo mode in the Graph sidecar',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = join(repoRoot, 'plugins', 'antigravity', 'siftable-graph');
const targetDir = resolve(
  values.target ?? join(homedir(), '.gemini', 'config', 'plugins', 'siftable-graph'),
);
const nodeBin = resolve(values.node ?? process.execPath);
const ownerConfig = resolve(values['owner-config'] ?? join(repoRoot, '.local', 'owner.json'));
const workerConfig = resolve(values['worker-config'] ?? join(repoRoot, '.local', 'worker.json'));

const graphServerEntry = join(repoRoot, 'apps', 'graph-ui', 'dist', 'server.js');
const mcpEntry = join(repoRoot, 'packages', 'mcp', 'dist', 'index.js');

if (!existsSync(graphServerEntry) || !existsSync(mcpEntry)) {
  process.stderr.write(
    JSON.stringify({
      error: 'Build artifacts missing; run `npm run build` before installing the plugin.',
      missing: [
        ...(!existsSync(graphServerEntry) ? [graphServerEntry] : []),
        ...(!existsSync(mcpEntry) ? [mcpEntry] : []),
      ],
    }) + '\n',
  );
  process.exit(1);
}

const sidecarDir = join(targetDir, 'sidecars', 'graph');
await mkdir(sidecarDir, { recursive: true });
await mkdir(join(targetDir, 'skills'), { recursive: true });
await mkdir(join(targetDir, 'rules'), { recursive: true });

const pluginManifest = {
  name: 'siftable-graph',
  displayName: 'Siftable Graph',
  version: '0.1.0',
  description:
    'Local dependency-ordered task/work DAG sidecar, MCP tools, and workflow skill backed by Siftable.',
  author: {
    name: 'Local Siftable Workspace',
  },
  keywords: ['siftable', 'dag', 'tasks', 'work-graph', 'dependencies', 'mcp', 'sidecar'],
};

const sidecarEnv = {
  SIFT_CONFIG: ownerConfig,
  ...(values.demo ? { SIFT_UI_DEMO: '1' } : {}),
};

const sidecarManifest = {
  command: nodeBin,
  args: [graphServerEntry],
  env: sidecarEnv,
  restart_policy: 'always',
  display_name: 'Siftable Graph',
  description:
    'Interactive dependency-ordered work graph, Next frontier queue, fork creator, and handback review pane backed by local Siftable.',
  has_web_ui: true,
  ui_config: {
    display_name: 'Siftable Graph',
    views: [
      {
        title: 'Siftable Graph',
        path: '/',
        entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
      },
    ],
  },
};

await writeFile(join(targetDir, 'plugin.json'), JSON.stringify(pluginManifest, null, 2) + '\n');
await writeFile(join(sidecarDir, 'sidecar.json'), JSON.stringify(sidecarManifest, null, 2) + '\n');
await cp(join(templateRoot, 'skills'), join(targetDir, 'skills'), { recursive: true });
await cp(join(templateRoot, 'rules'), join(targetDir, 'rules'), { recursive: true });

const hasWorkerConfig = existsSync(workerConfig);
const hasOwnerConfig = existsSync(ownerConfig);
let mcpStatus = 'skipped_missing_worker_credential';
let mcpCredentialPath = null;

if (hasWorkerConfig) {
  mcpCredentialPath = workerConfig;
  mcpStatus = 'configured_worker';
} else if (values['allow-owner-mcp'] && hasOwnerConfig) {
  mcpCredentialPath = ownerConfig;
  mcpStatus = 'configured_owner_override';
}

const mcpConfigPath = join(targetDir, 'mcp_config.json');
if (mcpCredentialPath) {
  const mcpConfig = {
    mcpServers: {
      siftable: {
        command: nodeBin,
        args: [mcpEntry],
        env: {
          SIFT_CONFIG: mcpCredentialPath,
          SIFT_TOOLS: 'projects,context,work,planning,extensions',
        },
      },
    },
  };
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
} else {
  await rm(mcpConfigPath, { force: true });
}

process.stdout.write(
  JSON.stringify(
    {
      installed: true,
      targetDir,
      sidecarPill: '[Siftable Graph](sidecar://siftable-graph/graph/)',
      sidecarConfig: hasOwnerConfig ? ownerConfig : `${ownerConfig} (demo mode until created)`,
      mcpStatus,
      ...(mcpCredentialPath
        ? { mcpConfig: mcpCredentialPath }
        : {
            nextStepForMcp:
              'Start local Siftable (`docker compose start` or `npm run local`), mint `.local/worker.json` per README.md, then re-run `npm run plugin:install` (or pass `-- --allow-owner-mcp`).',
          }),
    },
    null,
    2,
  ) + '\n',
);
