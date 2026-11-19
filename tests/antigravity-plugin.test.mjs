import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(
  new URL('../scripts/install-antigravity-plugin.mjs', import.meta.url),
);

test('install-antigravity-plugin generates valid plugin, sidecar, skill, and scoped MCP config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sift-agy-plugin-'));
  try {
    const targetDir = join(dir, 'siftable-graph');
    const ownerFile = join(dir, 'owner.json');
    const workerFile = join(dir, 'worker.json');
    await writeFile(ownerFile, '{}', { mode: 0o600 });

    // 1. Without worker.json: installs sidecar + skill + rules, omits broken mcp_config.json.
    const first = spawnSync(
      process.execPath,
      [
        installer,
        '--target',
        targetDir,
        '--owner-config',
        ownerFile,
        '--worker-config',
        workerFile,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(first.status, 0, first.stderr);
    const firstSummary = JSON.parse(first.stdout);
    assert.equal(firstSummary.installed, true);
    assert.equal(firstSummary.mcpStatus, 'skipped_missing_worker_credential');
    assert.equal(existsSync(join(targetDir, 'mcp_config.json')), false);

    const pluginJson = JSON.parse(await readFile(join(targetDir, 'plugin.json'), 'utf8'));
    assert.equal(pluginJson.name, 'siftable-graph');

    const sidecarJson = JSON.parse(
      await readFile(join(targetDir, 'sidecars', 'graph', 'sidecar.json'), 'utf8'),
    );
    assert.equal(sidecarJson.has_web_ui, true);
    assert.equal(sidecarJson.ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
    assert.equal(sidecarJson.env.SIFT_CONFIG, ownerFile);
    assert.equal(existsSync(join(targetDir, 'skills', 'siftable-dag', 'SKILL.md')), true);
    assert.equal(existsSync(join(targetDir, 'rules', 'AGENTS.md')), true);

    // 2. With worker.json present: writes mcp_config.json wired strictly to worker.json.
    await writeFile(workerFile, '{}', { mode: 0o600 });
    const second = spawnSync(
      process.execPath,
      [
        installer,
        '--target',
        targetDir,
        '--owner-config',
        ownerFile,
        '--worker-config',
        workerFile,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(second.status, 0, second.stderr);
    const secondSummary = JSON.parse(second.stdout);
    assert.equal(secondSummary.mcpStatus, 'configured_worker');

    const mcpJson = JSON.parse(await readFile(join(targetDir, 'mcp_config.json'), 'utf8'));
    assert.equal(mcpJson.mcpServers.siftable.env.SIFT_CONFIG, workerFile);
    assert.match(mcpJson.mcpServers.siftable.args[0], /packages\/mcp\/dist\/index\.js$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
