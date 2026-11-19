import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../packages/cli/dist/index.js', import.meta.url));
const run = (args, opts = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...opts });

function parseTomlWithPython(tomlText) {
  const res = spawnSync(
    'python3',
    ['-c', 'import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'],
    { input: tomlText, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    return null;
  }
  return JSON.parse(res.stdout);
}

test('sift --help and sift connect --help expose all harnesses and options without credentials', () => {
  const globalRes = run(['--help']);
  assert.equal(globalRes.status, 0, globalRes.stderr);
  const globalHelp = JSON.parse(globalRes.stdout);
  assert.match(globalHelp.connect, /connect <antigravity\|codex\|t3-code\|claude\|cursor>/);

  const connectRes = run(['connect', '--help']);
  assert.equal(connectRes.status, 0, connectRes.stderr);
  const help = JSON.parse(connectRes.stdout);
  assert.equal(help.command, 'sift connect');
  assert.deepEqual(Object.keys(help.harnesses).sort(), [
    'antigravity',
    'claude',
    'codex',
    'cursor',
    't3-code',
  ]);
  assert.ok('--dry-run' in help.options);
  assert.ok('--project-dir <path>' in help.options);
  assert.ok('--allow-owner-mcp' in help.options);

  const codexHelpRes = run(['connect', 'codex', '--help']);
  assert.equal(codexHelpRes.status, 0, codexHelpRes.stderr);
  assert.equal(JSON.parse(codexHelpRes.stdout).selectedHarness, 'codex');

  const badRes = run(['connect', 'unknown-harness']);
  assert.equal(badRes.status, 1);
  assert.equal(JSON.parse(badRes.stderr).code, 'invalid_input');
});

test('sift connect codex and t3-code merge TOML cleanly, preserve siblings, install portable skill, and use absolute paths', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sift-connect-codex-')));
  try {
    const sentinelToken = 'secret-token-must-never-appear-in-config-1234567890';
    const ownerFile = join(dir, 'owner.json');
    const workerFile = join(dir, 'worker.json');
    await writeFile(ownerFile, JSON.stringify({ token: 'owner-secret' }), { mode: 0o600 });
    await writeFile(workerFile, JSON.stringify({ token: sentinelToken }), { mode: 0o600 });

    const targetHome = join(dir, 'home');
    const codexConfigPath = join(targetHome, '.codex', 'config.toml');
    await mkdir(join(targetHome, '.codex'), { recursive: true });
    await writeFile(
      codexConfigPath,
      [
        '# Top-level comment must survive',
        'model = "gpt-5"',
        '',
        '[projects."/Users/example/work"]',
        'trust_level = "trusted"',
        '',
        '[mcp_servers.other]',
        'command = "/usr/local/bin/other-mcp"',
        'args = ["--serve"]',
        '',
        '[mcp_servers.other.env]',
        'OTHER_FLAG = "keep-me"',
        '',
        '[mcp_servers.siftable]',
        'command = "/old/node"',
        'args = ["/old/mcp.js"]',
        '',
        '[mcp_servers.siftable.env]',
        'SIFT_CONFIG = "/old/worker.json"',
        '',
        '[mcp_servers.siftable_extra]',
        'command = "/usr/local/bin/extra"',
        '',
      ].join('\n'),
      'utf8',
    );

    // Pass relative paths from `dir` to prove absolute path resolution.
    const relTarget = relative(dir, targetHome);
    const relWorker = relative(dir, workerFile);
    const relOwner = relative(dir, ownerFile);

    const res = run(
      [
        'connect',
        'codex',
        '--target',
        relTarget,
        '--worker-config',
        relWorker,
        '--owner-config',
        relOwner,
        '--tools',
        'projects,work',
      ],
      { cwd: dir },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.includes(sentinelToken), false);

    const summary = JSON.parse(res.stdout);
    assert.equal(summary.harness, 'codex');
    assert.equal(summary.installed, true);
    assert.equal(summary.dryRun, false);
    assert.equal(summary.mcpStatus, 'configured_worker');
    assert.equal(summary.mcpConfig, workerFile);
    assert.equal(isAbsolute(summary.nodeBin), true);
    assert.equal(isAbsolute(summary.mcpEntry), true);
    assert.match(summary.t3CodeInheritance, /shadowHomePath/);

    const updatedToml = await readFile(codexConfigPath, 'utf8');
    assert.equal(updatedToml.includes(sentinelToken), false);
    assert.match(updatedToml, /# Top-level comment must survive/);
    assert.match(updatedToml, /\[mcp_servers\.other\]/);
    assert.match(updatedToml, /OTHER_FLAG = "keep-me"/);
    assert.match(updatedToml, /\[mcp_servers\.siftable_extra\]/);
    assert.equal(updatedToml.includes('/old/node'), false);
    assert.equal((updatedToml.match(/^\[mcp_servers\.siftable\]$/gm) ?? []).length, 1);

    const parsedToml = parseTomlWithPython(updatedToml);
    if (parsedToml) {
      assert.equal(parsedToml.model, 'gpt-5');
      assert.equal(parsedToml.mcp_servers.other.command, '/usr/local/bin/other-mcp');
      assert.equal(parsedToml.mcp_servers.other.env.OTHER_FLAG, 'keep-me');
      assert.equal(parsedToml.mcp_servers.siftable_extra.command, '/usr/local/bin/extra');
      assert.equal(parsedToml.mcp_servers.siftable.command, process.execPath);
      assert.equal(isAbsolute(parsedToml.mcp_servers.siftable.args[0]), true);
      assert.match(parsedToml.mcp_servers.siftable.args[0], /packages\/mcp\/dist\/index\.js$/);
      assert.equal(parsedToml.mcp_servers.siftable.env.SIFT_CONFIG, workerFile);
      assert.equal(parsedToml.mcp_servers.siftable.env.SIFT_TOOLS, 'projects,work');
    }

    // Re-running t3-code against the same target is idempotent and notes shadowHomePath.
    const t3Res = run(
      [
        'connect',
        't3-code',
        '--target',
        targetHome,
        '--worker-config',
        workerFile,
        '--owner-config',
        ownerFile,
        '--tools',
        'projects,work',
      ],
      { cwd: dir },
    );
    assert.equal(t3Res.status, 0, t3Res.stderr);
    const t3Summary = JSON.parse(t3Res.stdout);
    assert.equal(t3Summary.harness, 't3-code');
    assert.match(t3Summary.t3CodeInheritance, /shadowHomePath/);
    assert.equal(await readFile(codexConfigPath, 'utf8'), updatedToml);

    // Portable skill installed with zero Antigravity sidecar:// links.
    const skillPath = join(targetHome, '.agents', 'skills', 'siftable-dag', 'SKILL.md');
    assert.equal(existsSync(skillPath), true);
    const skillContent = await readFile(skillPath, 'utf8');
    assert.equal(skillContent.includes('sidecar://'), false);
    assert.match(skillContent, /http:\/\/127\.0\.0\.1:7041/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sift connect claude merges ~/.claude.json and project .mcp.json and installs portable skill', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sift-connect-claude-'));
  try {
    const sentinelToken = 'claude-secret-token-never-embedded';
    const ownerFile = join(dir, 'owner.json');
    const workerFile = join(dir, 'worker.json');
    await writeFile(ownerFile, '{}', { mode: 0o600 });
    await writeFile(workerFile, JSON.stringify({ token: sentinelToken }), { mode: 0o600 });

    // 1. User-scoped (~/.claude.json via --target)
    const userHome = join(dir, 'user-home');
    await mkdir(userHome, { recursive: true });
    const claudeJsonPath = join(userHome, '.claude.json');
    await writeFile(
      claudeJsonPath,
      JSON.stringify(
        {
          numStartups: 42,
          mcpServers: {
            existing: { type: 'http', url: 'https://example.invalid/mcp' },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const userRes = run([
      'connect',
      'claude',
      '--target',
      userHome,
      '--worker-config',
      workerFile,
      '--owner-config',
      ownerFile,
    ]);
    assert.equal(userRes.status, 0, userRes.stderr);
    const userSummary = JSON.parse(userRes.stdout);
    assert.equal(userSummary.harness, 'claude');
    assert.equal(userSummary.projectScoped, false);
    assert.equal(userSummary.mcpStatus, 'configured_worker');

    const updatedClaude = JSON.parse(await readFile(claudeJsonPath, 'utf8'));
    assert.equal(updatedClaude.numStartups, 42);
    assert.deepEqual(updatedClaude.mcpServers.existing, {
      type: 'http',
      url: 'https://example.invalid/mcp',
    });
    assert.equal(updatedClaude.mcpServers.siftable.type, 'stdio');
    assert.equal(isAbsolute(updatedClaude.mcpServers.siftable.command), true);
    assert.equal(isAbsolute(updatedClaude.mcpServers.siftable.args[0]), true);
    assert.equal(updatedClaude.mcpServers.siftable.env.SIFT_CONFIG, workerFile);
    assert.equal(JSON.stringify(updatedClaude).includes(sentinelToken), false);

    const userSkill = join(userHome, '.claude', 'skills', 'siftable-dag', 'SKILL.md');
    assert.equal(existsSync(userSkill), true);
    assert.equal((await readFile(userSkill, 'utf8')).includes('sidecar://'), false);

    // 2. Repo-scoped (--project-dir writes <project>/.mcp.json + skill to --target)
    const projectDir = join(dir, 'repo');
    const customSkillTarget = join(dir, 'custom-claude-home');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { docs: { command: '/bin/echo', args: ['ok'] } } }, null, 2),
    );

    const projRes = run([
      'connect',
      'claude',
      '--project-dir',
      projectDir,
      '--target',
      customSkillTarget,
      '--worker-config',
      workerFile,
      '--owner-config',
      ownerFile,
    ]);
    assert.equal(projRes.status, 0, projRes.stderr);
    const projSummary = JSON.parse(projRes.stdout);
    assert.equal(projSummary.projectScoped, true);
    assert.equal(projSummary.mcpConfigPath, join(projectDir, '.mcp.json'));

    const projectMcp = JSON.parse(await readFile(join(projectDir, '.mcp.json'), 'utf8'));
    assert.deepEqual(projectMcp.mcpServers.docs, { command: '/bin/echo', args: ['ok'] });
    assert.equal(projectMcp.mcpServers.siftable.env.SIFT_CONFIG, workerFile);
    const projSkill = join(customSkillTarget, '.claude', 'skills', 'siftable-dag', 'SKILL.md');
    assert.equal(existsSync(projSkill), true);
    assert.equal((await readFile(projSkill, 'utf8')).includes('sidecar://'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sift connect cursor merges ~/.cursor/mcp.json and project .cursor/mcp.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sift-connect-cursor-'));
  try {
    const ownerFile = join(dir, 'owner.json');
    const workerFile = join(dir, 'worker.json');
    await writeFile(ownerFile, '{}', { mode: 0o600 });
    await writeFile(workerFile, '{}', { mode: 0o600 });

    // User-scoped via --target
    const cursorHome = join(dir, 'home');
    await mkdir(join(cursorHome, '.cursor'), { recursive: true });
    await writeFile(
      join(cursorHome, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { sibling: { command: '/bin/true', args: [] } } }, null, 2),
    );

    const userRes = run([
      'connect',
      'cursor',
      '--target',
      cursorHome,
      '--worker-config',
      workerFile,
      '--owner-config',
      ownerFile,
    ]);
    assert.equal(userRes.status, 0, userRes.stderr);
    const userJson = JSON.parse(await readFile(join(cursorHome, '.cursor', 'mcp.json'), 'utf8'));
    assert.deepEqual(userJson.mcpServers.sibling, { command: '/bin/true', args: [] });
    assert.equal(userJson.mcpServers.siftable.env.SIFT_CONFIG, workerFile);
    assert.equal(isAbsolute(userJson.mcpServers.siftable.args[0]), true);

    // Project-scoped via --project-dir
    const projectDir = join(dir, 'project');
    await mkdir(projectDir, { recursive: true });
    const projRes = run([
      'connect',
      'cursor',
      '--project-dir',
      projectDir,
      '--worker-config',
      workerFile,
      '--owner-config',
      ownerFile,
    ]);
    assert.equal(projRes.status, 0, projRes.stderr);
    const projSummary = JSON.parse(projRes.stdout);
    assert.equal(projSummary.projectScoped, true);
    assert.equal(projSummary.mcpConfigPath, join(projectDir, '.cursor', 'mcp.json'));
    const projJson = JSON.parse(await readFile(join(projectDir, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(projJson.mcpServers.siftable.env.SIFT_CONFIG, workerFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sift connect antigravity installs plugin, sidecar, skill, rules, and scoped MCP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sift-connect-agy-'));
  try {
    const targetDir = join(dir, 'siftable-graph');
    const ownerFile = join(dir, 'owner.json');
    const workerFile = join(dir, 'worker.json');
    await writeFile(ownerFile, '{}', { mode: 0o600 });
    await writeFile(workerFile, '{}', { mode: 0o600 });

    const res = run([
      'connect',
      'antigravity',
      '--target',
      targetDir,
      '--owner-config',
      ownerFile,
      '--worker-config',
      workerFile,
      '--demo',
    ]);
    assert.equal(res.status, 0, res.stderr);
    const summary = JSON.parse(res.stdout);
    assert.equal(summary.harness, 'antigravity');
    assert.equal(summary.installed, true);
    assert.equal(summary.mcpStatus, 'configured_worker');
    assert.equal(summary.sidecarPill, '[Siftable Graph](sidecar://siftable-graph/graph/)');

    const sidecar = JSON.parse(
      await readFile(join(targetDir, 'sidecars', 'graph', 'sidecar.json'), 'utf8'),
    );
    assert.equal(sidecar.env.SIFT_CONFIG, ownerFile);
    assert.equal(sidecar.env.SIFT_UI_DEMO, '1');
    assert.equal(isAbsolute(sidecar.args[0]), true);

    const mcp = JSON.parse(await readFile(join(targetDir, 'mcp_config.json'), 'utf8'));
    assert.equal(mcp.mcpServers.siftable.env.SIFT_CONFIG, workerFile);
    assert.equal(existsSync(join(targetDir, 'skills', 'siftable-dag', 'SKILL.md')), true);
    assert.equal(existsSync(join(targetDir, 'rules', 'AGENTS.md')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing worker credential safety, owner.json refusal without --allow-owner-mcp, and --dry-run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sift-connect-safety-'));
  try {
    const ownerFile = join(dir, 'owner.json');
    const missingWorker = join(dir, 'worker.json');
    await writeFile(ownerFile, '{}', { mode: 0o600 });

    // 1. Missing worker.json: skips MCP config and prints minting instructions (still installs skill).
    const codexHome = join(dir, 'codex-missing');
    const missingRes = run([
      'connect',
      'codex',
      '--target',
      codexHome,
      '--owner-config',
      ownerFile,
      '--worker-config',
      missingWorker,
    ]);
    assert.equal(missingRes.status, 0, missingRes.stderr);
    const missingSummary = JSON.parse(missingRes.stdout);
    assert.equal(missingSummary.mcpStatus, 'skipped_missing_worker_credential');
    assert.match(missingSummary.mintWorkerCommand, /admin credential/);
    assert.match(missingSummary.nextStepForMcp, /--allow-owner-mcp/);
    assert.equal(existsSync(join(codexHome, '.codex', 'config.toml')), false);
    assert.equal(
      existsSync(join(codexHome, '.agents', 'skills', 'siftable-dag', 'SKILL.md')),
      true,
    );

    // 2. Explicitly passing owner.json as --worker-config without --allow-owner-mcp is refused.
    const refusedRes = run([
      'connect',
      'cursor',
      '--target',
      join(dir, 'cursor-refused'),
      '--owner-config',
      ownerFile,
      '--worker-config',
      ownerFile,
    ]);
    assert.equal(refusedRes.status, 1);
    const refusedErr = JSON.parse(refusedRes.stderr);
    assert.equal(refusedErr.code, 'owner_mcp_refused');
    assert.equal(existsSync(join(dir, 'cursor-refused')), false);

    // 3. Explicit --allow-owner-mcp opts into owner.json when worker.json is missing.
    const allowHome = join(dir, 'cursor-allowed');
    const allowRes = run([
      'connect',
      'cursor',
      '--target',
      allowHome,
      '--owner-config',
      ownerFile,
      '--worker-config',
      missingWorker,
      '--allow-owner-mcp',
    ]);
    assert.equal(allowRes.status, 0, allowRes.stderr);
    const allowSummary = JSON.parse(allowRes.stdout);
    assert.equal(allowSummary.mcpStatus, 'configured_owner_override');
    const allowJson = JSON.parse(await readFile(join(allowHome, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(allowJson.mcpServers.siftable.env.SIFT_CONFIG, ownerFile);

    // 4. --dry-run writes zero files across harnesses.
    const workerFile = join(dir, 'real-worker.json');
    await writeFile(workerFile, '{}', { mode: 0o600 });
    for (const harness of ['antigravity', 'codex', 't3-code', 'claude', 'cursor']) {
      const dryTarget = join(dir, `dry-${harness}`);
      const dryRes = run([
        'connect',
        harness,
        '--dry-run',
        '--target',
        dryTarget,
        '--owner-config',
        ownerFile,
        '--worker-config',
        workerFile,
      ]);
      assert.equal(dryRes.status, 0, `${harness}: ${dryRes.stderr}`);
      const drySummary = JSON.parse(dryRes.stdout);
      assert.equal(drySummary.dryRun, true);
      assert.equal(drySummary.installed, false);
      assert.equal(drySummary.mcpStatus, 'configured_worker');
      assert.ok(Array.isArray(drySummary.files) && drySummary.files.length > 0);
      assert.equal(existsSync(dryTarget), false, `${harness} --dry-run created files!`);
    }

    // 5. Invalid existing JSON MCP config fails cleanly instead of clobbering.
    const badJsonDir = join(dir, 'bad-json');
    await mkdir(join(badJsonDir, '.cursor'), { recursive: true });
    await writeFile(join(badJsonDir, '.cursor', 'mcp.json'), '{not-valid-json', 'utf8');
    const badJsonRes = run([
      'connect',
      'cursor',
      '--target',
      badJsonDir,
      '--owner-config',
      ownerFile,
      '--worker-config',
      workerFile,
    ]);
    assert.equal(badJsonRes.status, 1);
    assert.equal(JSON.parse(badJsonRes.stderr).code, 'invalid_config_file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
