import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

test('config.info exposes only identity metadata and respects protected-file checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sift-config-test-'));
  try {
    const path = join(directory, 'owner.json');
    const metadata = { ownerId: randomUUID(), principalId: randomUUID(), scopeId: null };
    const token = 'test-only-opaque-credential-do-not-emit';
    await writeFile(path, JSON.stringify({ ...metadata, apiUrl: 'http://127.0.0.1:1', token }), {
      mode: 0o600,
    });
    const run = () =>
      spawnSync(process.execPath, ['packages/cli/dist/index.js', 'config.info', '--config', path], {
        encoding: 'utf8',
      });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), metadata);
    assert.equal((result.stdout + result.stderr).includes(token), false);
    await chmod(path, 0o644);
    result = run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /mode 0600/);
    assert.equal(result.stderr.includes(token), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
