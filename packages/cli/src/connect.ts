import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONNECT_HARNESSES = ['antigravity', 'codex', 't3-code', 'claude', 'cursor'] as const;
export type ConnectHarness = (typeof CONNECT_HARNESSES)[number];

export const DEFAULT_CONNECT_TOOLS = 'projects,context,work,planning,extensions';

export type McpStatus =
  'configured_worker' | 'configured_owner_override' | 'skipped_missing_worker_credential';

export interface ConnectOptions {
  harness: string;
  dryRun?: boolean;
  target?: string;
  repoRoot?: string;
  node?: string;
  ownerConfig?: string;
  workerConfig?: string;
  allowOwnerMcp?: boolean;
  demo?: boolean;
  tools?: string;
  projectDir?: string;
}

export interface ConnectFilePlan {
  path: string;
  action: 'write' | 'merge' | 'copy' | 'remove' | 'skip';
  reason?: string;
}

export interface ConnectResult {
  harness: ConnectHarness;
  dryRun: boolean;
  installed: boolean;
  repoRoot: string;
  nodeBin: string;
  mcpEntry: string;
  tools: string;
  mcpStatus: McpStatus;
  mcpConfigPath: string;
  mcpConfig?: string;
  skillPath?: string;
  targetDir?: string;
  graphServerEntry?: string;
  sidecarPill?: string;
  sidecarConfig?: string;
  projectScoped?: boolean;
  t3CodeInheritance?: string;
  notes: string[];
  files: ConnectFilePlan[];
  nextStepForMcp?: string;
  mintWorkerCommand?: string;
}

export class ConnectError extends Error {
  code: string;
  suggestions?: string[];

  constructor(message: string, code: string, suggestions?: string[]) {
    super(message);
    this.name = 'ConnectError';
    this.code = code;
    this.suggestions = suggestions;
  }
}

export function isConnectHarness(value: string): value is ConnectHarness {
  return (CONNECT_HARNESSES as readonly string[]).includes(value);
}

export function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function connectHelp(harness?: string) {
  if (harness && !isConnectHarness(harness)) {
    throw new ConnectError(
      `Unknown harness "${harness}". Supported harnesses: ${CONNECT_HARNESSES.join(', ')}.`,
      'invalid_input',
      ['Run `sift connect --help` to see supported harnesses and options.'],
    );
  }
  return {
    command: 'sift connect',
    usage: 'sift connect <antigravity|codex|t3-code|claude|cursor> [options]',
    harnesses: {
      antigravity:
        'Installs the Antigravity plugin (~/.gemini/config/plugins/siftable-graph) with Graph sidecar, plugin skill, rules, and scoped MCP config.',
      codex:
        'Merges [mcp_servers.siftable] into ~/.codex/config.toml and installs portable .agents/skills/siftable-dag/SKILL.md into ~/.agents/skills/siftable-dag/SKILL.md.',
      't3-code':
        'Same config and portable skill as codex; upstream T3 Code inherits ~/.codex/config.toml and skills across git worktrees via shadowHomePath.',
      claude:
        'Merges mcpServers.siftable into ~/.claude.json (or <project-dir>/.mcp.json with --project-dir) and installs portable siftable-dag skill into ~/.claude/skills/siftable-dag/SKILL.md.',
      cursor:
        'Merges mcpServers.siftable into ~/.cursor/mcp.json (or <project-dir>/.cursor/mcp.json with --project-dir).',
    },
    ...(harness ? { selectedHarness: harness } : {}),
    options: {
      '--dry-run': 'Validate inputs and print planned config changes without writing files',
      '--target <path>':
        'Override install root or config file path (defaults to harness user home location)',
      '--project-dir <path>':
        'Write repo-scoped MCP config (<project-dir>/.mcp.json for claude, <project-dir>/.cursor/mcp.json for cursor)',
      '--repo-root <path>': 'Override Siftable repository root (default: auto-detected)',
      '--node <path>': 'Absolute Node.js >=22 binary path (default: current process.execPath)',
      '--owner-config <path>':
        'Credential file for Antigravity Graph sidecar (default: <repo>/.local/owner.json)',
      '--worker-config <path>':
        'Scoped agent credential file for MCP (default: <repo>/.local/worker.json)',
      '--allow-owner-mcp':
        'Explicitly opt in to wiring MCP to owner.json when worker.json is absent',
      '--demo': 'Force interactive demo mode in the Antigravity Graph sidecar',
      '--tools <csv>': `Comma-separated SIFT_TOOLS filter (default: ${DEFAULT_CONNECT_TOOLS})`,
    },
    safety: [
      'Always writes absolute paths so git worktrees share one credential and lease store.',
      'Never embeds secret tokens in harness configs—only credential file paths (SIFT_CONFIG).',
      'Refuses to wire MCP to owner.json unless --allow-owner-mcp is explicitly passed.',
      'When worker.json is missing, skips MCP config and prints exact credential minting instructions.',
    ],
  };
}

function tomlString(value: string): string {
  return (
    '"' +
    value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\b', '\\b')
      .replaceAll('\t', '\\t')
      .replaceAll('\n', '\\n')
      .replaceAll('\f', '\\f')
      .replaceAll('\r', '\\r') +
    '"'
  );
}

export function renderCodexMcpBlock(config: {
  command: string;
  args: string[];
  env: Record<string, string>;
}): string {
  const argsList = config.args.map(tomlString).join(', ');
  const envLines = Object.entries(config.env).map(([k, v]) => `${k} = ${tomlString(v)}`);
  return [
    '[mcp_servers.siftable]',
    `command = ${tomlString(config.command)}`,
    `args = [${argsList}]`,
    '',
    '[mcp_servers.siftable.env]',
    ...envLines,
  ].join('\n');
}

function parseTomlTableHeader(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[')) return null;
  const isArrayTable = trimmed.startsWith('[[');
  let i = isArrayTable ? 2 : 1;
  const len = trimmed.length;
  const segments: string[] = [];

  const skipWs = () => {
    while (i < len && (trimmed[i] === ' ' || trimmed[i] === '\t')) i++;
  };

  while (i < len) {
    skipWs();
    if (i >= len) return null;
    const ch = trimmed[i];
    if (ch === '"') {
      i++;
      let seg = '';
      while (i < len && trimmed[i] !== '"') {
        if (trimmed[i] === '\\' && i + 1 < len) {
          i++;
          const esc = trimmed[i] ?? '';
          if (esc === 'n') seg += '\n';
          else if (esc === 't') seg += '\t';
          else if (esc === 'r') seg += '\r';
          else seg += esc;
        } else {
          seg += trimmed[i] ?? '';
        }
        i++;
      }
      if (trimmed[i] !== '"') return null;
      i++;
      segments.push(seg);
    } else if (ch === "'") {
      i++;
      let seg = '';
      while (i < len && trimmed[i] !== "'") {
        seg += trimmed[i] ?? '';
        i++;
      }
      if (trimmed[i] !== "'") return null;
      i++;
      segments.push(seg);
    } else {
      let seg = '';
      while (i < len && /[A-Za-z0-9_-]/.test(trimmed[i] ?? '')) {
        seg += trimmed[i] ?? '';
        i++;
      }
      if (!seg) return null;
      segments.push(seg);
    }
    skipWs();
    if (trimmed[i] === '.') {
      i++;
      continue;
    }
    if (isArrayTable) {
      if (trimmed[i] !== ']' || trimmed[i + 1] !== ']') return null;
      i += 2;
    } else {
      if (trimmed[i] !== ']') return null;
      i += 1;
    }
    skipWs();
    if (i < len && trimmed[i] !== '#') return null;
    return segments;
  }
  return null;
}

function updateMultilineDelimiter(
  line: string,
  active: '"""' | "'''" | null,
): '"""' | "'''" | null {
  let state = active;
  let i = 0;
  while (i < line.length) {
    if (state === null) {
      if (line[i] === '#') break;
      if (line.startsWith('"""', i)) {
        state = '"""';
        i += 3;
        continue;
      }
      if (line.startsWith("'''", i)) {
        state = "'''";
        i += 3;
        continue;
      }
      if (line[i] === '"') {
        i++;
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (line[i] === "'") {
        i++;
        while (i < line.length && line[i] !== "'") i++;
        i++;
        continue;
      }
      i++;
    } else if (state === '"""') {
      if (line[i] === '\\') {
        i += 2;
        continue;
      }
      if (line.startsWith('"""', i)) {
        state = null;
        i += 3;
        continue;
      }
      i++;
    } else {
      if (line.startsWith("'''", i)) {
        state = null;
        i += 3;
        continue;
      }
      i++;
    }
  }
  return state;
}

function isSiftableMcpSection(header: string[] | null): boolean {
  return Boolean(
    header && header.length >= 2 && header[0] === 'mcp_servers' && header[1] === 'siftable',
  );
}

export function mergeCodexToml(existing: string | null, serverBlock: string): string {
  const normalized = (existing ?? '').replaceAll('\r\n', '\n');
  if (normalized.trim() === '') {
    return serverBlock + '\n';
  }

  const rawLines = normalized.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  interface TomlSection {
    header: string[] | null;
    lines: string[];
  }

  const sections: TomlSection[] = [{ header: null, lines: [] }];
  let multilineState: '"""' | "'''" | null = null;

  for (const line of rawLines) {
    if (multilineState === null) {
      const header = parseTomlTableHeader(line);
      if (header) {
        sections.push({ header, lines: [line] });
        continue;
      }
    }
    sections[sections.length - 1]!.lines.push(line);
    multilineState = updateMultilineDelimiter(line, multilineState);
  }

  const blockLines = serverBlock.split('\n');
  const outputSections: string[][] = [];
  let inserted = false;

  for (const section of sections) {
    if (isSiftableMcpSection(section.header)) {
      if (!inserted) {
        outputSections.push(blockLines);
        inserted = true;
      }
      continue;
    }
    if (section.header === null && section.lines.every((l) => l.trim() === '')) {
      continue;
    }
    outputSections.push(section.lines);
  }

  if (!inserted) {
    outputSections.push(blockLines);
  }

  const outLines: string[] = [];
  for (let idx = 0; idx < outputSections.length; idx++) {
    const lines = [...outputSections[idx]!];
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (outLines.length > 0) {
      outLines.push('');
    }
    outLines.push(...lines);
  }

  return outLines.join('\n') + '\n';
}

export function mergeJsonMcpConfig(
  existingRaw: string | null,
  entry: Record<string, unknown>,
  filePath: string,
): string {
  let root: Record<string, unknown> = {};
  if (existingRaw !== null && existingRaw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingRaw);
    } catch {
      throw new ConnectError(
        `Existing MCP config at ${filePath} is not valid JSON.`,
        'invalid_config_file',
        [`Fix or back up ${filePath} before running \`sift connect\`.`],
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConnectError(
        `Existing MCP config at ${filePath} must be a JSON object.`,
        'invalid_config_file',
        [`Fix or back up ${filePath} before running \`sift connect\`.`],
      );
    }
    root = { ...(parsed as Record<string, unknown>) };
  }

  let servers: Record<string, unknown> = {};
  if (root.mcpServers !== undefined) {
    if (!root.mcpServers || typeof root.mcpServers !== 'object' || Array.isArray(root.mcpServers)) {
      throw new ConnectError(
        `Existing \`mcpServers\` field in ${filePath} must be a JSON object.`,
        'invalid_config_file',
        [`Fix \`mcpServers\` in ${filePath} before running \`sift connect\`.`],
      );
    }
    servers = { ...(root.mcpServers as Record<string, unknown>) };
  }

  servers.siftable = entry;
  root.mcpServers = servers;
  return JSON.stringify(root, null, 2) + '\n';
}

async function readFileIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, 'utf8');
}

function buildMintingGuidance(
  harness: ConnectHarness,
  repoRoot: string,
  nodeBin: string,
  ownerConfig: string,
  workerConfig: string,
): { mintWorkerCommand: string; nextStepForMcp: string } {
  const cliEntry = resolve(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  const mintWorkerCommand = [
    `OWNER_ID=$(${nodeBin} ${cliEntry} config.info --config ${ownerConfig} | ${nodeBin} -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).ownerId')`,
    'docker compose run --rm admin credential --owner-id "$OWNER_ID" --role agent --permissions foundation:read,projects:read,context:read,context:write,work:read,work:write --output /run/sift/worker.json --url "http://127.0.0.1:${SIFT_PORT:-8088}"',
  ].join(' && ');
  const nextStepForMcp = `Worker credential missing at ${workerConfig}. Start local Siftable (\`docker compose start\` or \`npm run local\`), mint a scoped worker credential (\`${mintWorkerCommand}\`), then re-run \`sift connect ${harness}\` (or pass \`--allow-owner-mcp\` to explicitly allow owner.json).`;
  return { mintWorkerCommand, nextStepForMcp };
}

function resolveMcpCredential(params: {
  harness: ConnectHarness;
  repoRoot: string;
  nodeBin: string;
  ownerConfig: string;
  workerConfig: string;
  allowOwnerMcp: boolean;
}): {
  mcpStatus: McpStatus;
  mcpCredentialPath: string | null;
  nextStepForMcp?: string;
  mintWorkerCommand?: string;
} {
  const { harness, repoRoot, nodeBin, ownerConfig, workerConfig, allowOwnerMcp } = params;
  const pointsToOwner = workerConfig === ownerConfig || basename(workerConfig) === 'owner.json';

  if (pointsToOwner && !allowOwnerMcp) {
    throw new ConnectError(
      `Refusing to write MCP config using owner credential (${workerConfig}) without --allow-owner-mcp.`,
      'owner_mcp_refused',
      [
        'Mint a scoped agent credential at .local/worker.json instead of giving MCP owner privileges.',
        'Pass --allow-owner-mcp explicitly only if you intentionally want MCP to use owner.json.',
      ],
    );
  }

  if (existsSync(workerConfig)) {
    return {
      mcpStatus: pointsToOwner ? 'configured_owner_override' : 'configured_worker',
      mcpCredentialPath: workerConfig,
    };
  }

  if (allowOwnerMcp && existsSync(ownerConfig)) {
    return {
      mcpStatus: 'configured_owner_override',
      mcpCredentialPath: ownerConfig,
    };
  }

  const guidance = buildMintingGuidance(harness, repoRoot, nodeBin, ownerConfig, workerConfig);
  return {
    mcpStatus: 'skipped_missing_worker_credential',
    mcpCredentialPath: null,
    ...guidance,
  };
}

function resolveCodexPaths(target?: string): { configPath: string; skillPath: string } {
  if (!target) {
    const home = homedir();
    return {
      configPath: resolve(home, '.codex', 'config.toml'),
      skillPath: resolve(home, '.agents', 'skills', 'siftable-dag', 'SKILL.md'),
    };
  }
  const absTarget = resolve(target);
  if (absTarget.endsWith('.toml')) {
    const parent = dirname(absTarget);
    const skillBase = basename(parent) === '.codex' ? dirname(parent) : parent;
    return {
      configPath: absTarget,
      skillPath: resolve(skillBase, '.agents', 'skills', 'siftable-dag', 'SKILL.md'),
    };
  }
  return {
    configPath: resolve(absTarget, '.codex', 'config.toml'),
    skillPath: resolve(absTarget, '.agents', 'skills', 'siftable-dag', 'SKILL.md'),
  };
}

function resolveClaudePaths(
  target?: string,
  projectDir?: string,
): { mcpConfigPath: string; skillPath: string; projectScoped: boolean } {
  const home = homedir();
  if (projectDir) {
    const mcpConfigPath = resolve(projectDir, '.mcp.json');
    let skillPath = resolve(home, '.claude', 'skills', 'siftable-dag', 'SKILL.md');
    if (target) {
      const absTarget = resolve(target);
      if (absTarget.endsWith('SKILL.md')) {
        skillPath = absTarget;
      } else if (basename(absTarget) === 'siftable-dag') {
        skillPath = resolve(absTarget, 'SKILL.md');
      } else if (basename(absTarget) === 'skills') {
        skillPath = resolve(absTarget, 'siftable-dag', 'SKILL.md');
      } else if (basename(absTarget) === '.claude') {
        skillPath = resolve(absTarget, 'skills', 'siftable-dag', 'SKILL.md');
      } else {
        skillPath = resolve(absTarget, '.claude', 'skills', 'siftable-dag', 'SKILL.md');
      }
    }
    return { mcpConfigPath, skillPath, projectScoped: true };
  }

  if (target) {
    const absTarget = resolve(target);
    if (absTarget.endsWith('.json')) {
      return {
        mcpConfigPath: absTarget,
        skillPath: resolve(dirname(absTarget), '.claude', 'skills', 'siftable-dag', 'SKILL.md'),
        projectScoped: false,
      };
    }
    return {
      mcpConfigPath: resolve(absTarget, '.claude.json'),
      skillPath: resolve(absTarget, '.claude', 'skills', 'siftable-dag', 'SKILL.md'),
      projectScoped: false,
    };
  }

  return {
    mcpConfigPath: resolve(home, '.claude.json'),
    skillPath: resolve(home, '.claude', 'skills', 'siftable-dag', 'SKILL.md'),
    projectScoped: false,
  };
}

function resolveCursorPath(
  target?: string,
  projectDir?: string,
): { mcpConfigPath: string; projectScoped: boolean } {
  if (projectDir) {
    return {
      mcpConfigPath: resolve(projectDir, '.cursor', 'mcp.json'),
      projectScoped: true,
    };
  }
  if (target) {
    const absTarget = resolve(target);
    if (absTarget.endsWith('.json')) {
      return { mcpConfigPath: absTarget, projectScoped: false };
    }
    if (basename(absTarget) === '.cursor') {
      return { mcpConfigPath: resolve(absTarget, 'mcp.json'), projectScoped: false };
    }
    return { mcpConfigPath: resolve(absTarget, '.cursor', 'mcp.json'), projectScoped: false };
  }
  return {
    mcpConfigPath: resolve(homedir(), '.cursor', 'mcp.json'),
    projectScoped: false,
  };
}

export async function runConnect(options: ConnectOptions): Promise<ConnectResult> {
  if (!isConnectHarness(options.harness)) {
    throw new ConnectError(
      `Unknown harness "${options.harness}". Supported harnesses: ${CONNECT_HARNESSES.join(', ')}.`,
      'invalid_input',
      ['Run `sift connect --help` to see supported harnesses and options.'],
    );
  }

  const harness = options.harness;
  const dryRun = Boolean(options.dryRun);
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot());
  const nodeBin = resolve(options.node ?? process.execPath);
  const ownerConfig = resolve(options.ownerConfig ?? join(repoRoot, '.local', 'owner.json'));
  const workerConfig = resolve(options.workerConfig ?? join(repoRoot, '.local', 'worker.json'));
  const tools = (options.tools ?? DEFAULT_CONNECT_TOOLS).trim() || DEFAULT_CONNECT_TOOLS;

  const mcpEntry = resolve(repoRoot, 'packages', 'mcp', 'dist', 'index.js');
  const graphServerEntry = resolve(repoRoot, 'apps', 'graph-ui', 'dist', 'server.js');
  const portableSkillSource = resolve(repoRoot, '.agents', 'skills', 'siftable-dag', 'SKILL.md');
  const antigravityTemplateRoot = resolve(repoRoot, 'plugins', 'antigravity', 'siftable-graph');

  const missingArtifacts: string[] = [];
  if (!existsSync(mcpEntry)) missingArtifacts.push(mcpEntry);
  if (harness === 'antigravity' && !existsSync(graphServerEntry)) {
    missingArtifacts.push(graphServerEntry);
  }
  if (missingArtifacts.length > 0) {
    throw new ConnectError(
      `Build artifacts missing (${missingArtifacts.join(', ')}); run \`npm run build\` before connecting.`,
      'missing_build_artifacts',
      ['Run `npm run build` from the Siftable repository root, then re-run `sift connect`.'],
    );
  }

  const cred = resolveMcpCredential({
    harness,
    repoRoot,
    nodeBin,
    ownerConfig,
    workerConfig,
    allowOwnerMcp: Boolean(options.allowOwnerMcp),
  });

  if (harness === 'antigravity') {
    const targetDir = resolve(
      options.target ?? join(homedir(), '.gemini', 'config', 'plugins', 'siftable-graph'),
    );
    const sidecarDir = join(targetDir, 'sidecars', 'graph');
    const pluginManifestPath = join(targetDir, 'plugin.json');
    const sidecarManifestPath = join(sidecarDir, 'sidecar.json');
    const skillsTargetDir = join(targetDir, 'skills');
    const rulesTargetDir = join(targetDir, 'rules');
    const mcpConfigPath = join(targetDir, 'mcp_config.json');
    const hasOwnerConfig = existsSync(ownerConfig);

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

    const sidecarEnv: Record<string, string> = {
      SIFT_CONFIG: ownerConfig,
      ...(options.demo ? { SIFT_UI_DEMO: '1' } : {}),
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

    const files: ConnectFilePlan[] = [
      { path: pluginManifestPath, action: 'write' },
      { path: sidecarManifestPath, action: 'write' },
      { path: skillsTargetDir, action: 'copy' },
      { path: rulesTargetDir, action: 'copy' },
    ];

    if (cred.mcpCredentialPath) {
      files.push({ path: mcpConfigPath, action: 'write' });
    } else {
      files.push({
        path: mcpConfigPath,
        action: existsSync(mcpConfigPath) ? 'remove' : 'skip',
        reason: 'skipped_missing_worker_credential',
      });
    }

    if (!dryRun) {
      await mkdir(sidecarDir, { recursive: true });
      await mkdir(skillsTargetDir, { recursive: true });
      await mkdir(rulesTargetDir, { recursive: true });
      await writeFile(pluginManifestPath, JSON.stringify(pluginManifest, null, 2) + '\n');
      await writeFile(sidecarManifestPath, JSON.stringify(sidecarManifest, null, 2) + '\n');
      await cp(join(antigravityTemplateRoot, 'skills'), skillsTargetDir, { recursive: true });
      await cp(join(antigravityTemplateRoot, 'rules'), rulesTargetDir, { recursive: true });

      if (cred.mcpCredentialPath) {
        const mcpConfig = {
          mcpServers: {
            siftable: {
              command: nodeBin,
              args: [mcpEntry],
              env: {
                SIFT_CONFIG: cred.mcpCredentialPath,
                SIFT_TOOLS: tools,
              },
            },
          },
        };
        await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
      } else {
        await rm(mcpConfigPath, { force: true });
      }
    }

    return {
      harness,
      dryRun,
      installed: !dryRun,
      repoRoot,
      nodeBin,
      mcpEntry,
      graphServerEntry,
      tools,
      targetDir,
      skillPath: join(skillsTargetDir, 'siftable-dag', 'SKILL.md'),
      sidecarPill: '[Siftable Graph](sidecar://siftable-graph/graph/)',
      sidecarConfig: hasOwnerConfig ? ownerConfig : `${ownerConfig} (demo mode until created)`,
      mcpStatus: cred.mcpStatus,
      mcpConfigPath,
      ...(cred.mcpCredentialPath ? { mcpConfig: cred.mcpCredentialPath } : {}),
      ...(cred.nextStepForMcp ? { nextStepForMcp: cred.nextStepForMcp } : {}),
      ...(cred.mintWorkerCommand ? { mintWorkerCommand: cred.mintWorkerCommand } : {}),
      notes: [
        'All entrypoints and credential paths are absolute so Antigravity worktrees share one credential and lease store.',
      ],
      files,
    };
  }

  if (harness === 'codex' || harness === 't3-code') {
    if (!existsSync(portableSkillSource)) {
      throw new ConnectError(
        `Portable skill source missing at ${portableSkillSource}.`,
        'missing_skill_source',
        ['Verify `.agents/skills/siftable-dag/SKILL.md` exists in the Siftable repository.'],
      );
    }

    const { configPath, skillPath } = resolveCodexPaths(options.target);
    const files: ConnectFilePlan[] = [{ path: skillPath, action: 'copy' }];
    let mergedToml: string | null = null;

    if (cred.mcpCredentialPath) {
      const existingToml = await readFileIfExists(configPath);
      const serverBlock = renderCodexMcpBlock({
        command: nodeBin,
        args: [mcpEntry],
        env: {
          SIFT_CONFIG: cred.mcpCredentialPath,
          SIFT_TOOLS: tools,
        },
      });
      mergedToml = mergeCodexToml(existingToml, serverBlock);
      files.push({ path: configPath, action: existingToml !== null ? 'merge' : 'write' });
    } else {
      files.push({
        path: configPath,
        action: 'skip',
        reason: 'skipped_missing_worker_credential',
      });
    }

    if (!dryRun) {
      await mkdir(dirname(skillPath), { recursive: true });
      await cp(portableSkillSource, skillPath);
      if (mergedToml !== null) {
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, mergedToml, 'utf8');
      }
    }

    const t3CodeInheritance =
      'Upstream T3 Code inherits ~/.codex/config.toml and ~/.agents/skills/siftable-dag/SKILL.md across git worktrees via shadowHomePath; absolute paths ensure every worktree shares one credential and lease store.';

    return {
      harness,
      dryRun,
      installed: !dryRun,
      repoRoot,
      nodeBin,
      mcpEntry,
      tools,
      mcpStatus: cred.mcpStatus,
      mcpConfigPath: configPath,
      skillPath,
      t3CodeInheritance,
      ...(cred.mcpCredentialPath ? { mcpConfig: cred.mcpCredentialPath } : {}),
      ...(cred.nextStepForMcp ? { nextStepForMcp: cred.nextStepForMcp } : {}),
      ...(cred.mintWorkerCommand ? { mintWorkerCommand: cred.mintWorkerCommand } : {}),
      notes: [
        t3CodeInheritance,
        'Portable siftable-dag skill installed without Antigravity-only sidecar:// links.',
      ],
      files,
    };
  }

  if (harness === 'claude') {
    if (!existsSync(portableSkillSource)) {
      throw new ConnectError(
        `Portable skill source missing at ${portableSkillSource}.`,
        'missing_skill_source',
        ['Verify `.agents/skills/siftable-dag/SKILL.md` exists in the Siftable repository.'],
      );
    }

    const { mcpConfigPath, skillPath, projectScoped } = resolveClaudePaths(
      options.target,
      options.projectDir,
    );
    const files: ConnectFilePlan[] = [{ path: skillPath, action: 'copy' }];
    let mergedJson: string | null = null;

    if (cred.mcpCredentialPath) {
      const existingRaw = await readFileIfExists(mcpConfigPath);
      mergedJson = mergeJsonMcpConfig(
        existingRaw,
        {
          type: 'stdio',
          command: nodeBin,
          args: [mcpEntry],
          env: {
            SIFT_CONFIG: cred.mcpCredentialPath,
            SIFT_TOOLS: tools,
          },
        },
        mcpConfigPath,
      );
      files.push({ path: mcpConfigPath, action: existingRaw !== null ? 'merge' : 'write' });
    } else {
      files.push({
        path: mcpConfigPath,
        action: 'skip',
        reason: 'skipped_missing_worker_credential',
      });
    }

    if (!dryRun) {
      await mkdir(dirname(skillPath), { recursive: true });
      await cp(portableSkillSource, skillPath);
      if (mergedJson !== null) {
        await mkdir(dirname(mcpConfigPath), { recursive: true });
        await writeFile(mcpConfigPath, mergedJson, 'utf8');
      }
    }

    return {
      harness,
      dryRun,
      installed: !dryRun,
      repoRoot,
      nodeBin,
      mcpEntry,
      tools,
      mcpStatus: cred.mcpStatus,
      mcpConfigPath,
      skillPath,
      projectScoped,
      ...(cred.mcpCredentialPath ? { mcpConfig: cred.mcpCredentialPath } : {}),
      ...(cred.nextStepForMcp ? { nextStepForMcp: cred.nextStepForMcp } : {}),
      ...(cred.mintWorkerCommand ? { mintWorkerCommand: cred.mintWorkerCommand } : {}),
      notes: [
        projectScoped
          ? 'Repo-scoped .mcp.json allows Claude Code and T3 Code customHome Claude sessions in this repository to discover Siftable MCP.'
          : 'User-scoped ~/.claude.json configured with absolute paths; pass --project-dir <repo> to also write repo-scoped .mcp.json for T3 Code customHome Claude sessions.',
        'Portable siftable-dag skill installed without Antigravity-only sidecar:// links.',
      ],
      files,
    };
  }

  // cursor
  const { mcpConfigPath, projectScoped } = resolveCursorPath(options.target, options.projectDir);
  const files: ConnectFilePlan[] = [];
  let mergedJson: string | null = null;

  if (cred.mcpCredentialPath) {
    const existingRaw = await readFileIfExists(mcpConfigPath);
    mergedJson = mergeJsonMcpConfig(
      existingRaw,
      {
        command: nodeBin,
        args: [mcpEntry],
        env: {
          SIFT_CONFIG: cred.mcpCredentialPath,
          SIFT_TOOLS: tools,
        },
      },
      mcpConfigPath,
    );
    files.push({ path: mcpConfigPath, action: existingRaw !== null ? 'merge' : 'write' });
  } else {
    files.push({
      path: mcpConfigPath,
      action: 'skip',
      reason: 'skipped_missing_worker_credential',
    });
  }

  if (!dryRun && mergedJson !== null) {
    await mkdir(dirname(mcpConfigPath), { recursive: true });
    await writeFile(mcpConfigPath, mergedJson, 'utf8');
  }

  return {
    harness,
    dryRun,
    installed: !dryRun,
    repoRoot,
    nodeBin,
    mcpEntry,
    tools,
    mcpStatus: cred.mcpStatus,
    mcpConfigPath,
    projectScoped,
    ...(cred.mcpCredentialPath ? { mcpConfig: cred.mcpCredentialPath } : {}),
    ...(cred.nextStepForMcp ? { nextStepForMcp: cred.nextStepForMcp } : {}),
    ...(cred.mintWorkerCommand ? { mintWorkerCommand: cred.mintWorkerCommand } : {}),
    notes: [
      projectScoped
        ? 'Repo-scoped .cursor/mcp.json configured with absolute paths.'
        : 'User-scoped ~/.cursor/mcp.json configured with absolute paths.',
    ],
    files,
  };
}
