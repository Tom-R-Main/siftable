import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { SiftClient } from '../packages/client/dist/index.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const claimIdOf = (secret) => sha256(`siftable-lease:${sha256(secret)}`);

async function startStubApi() {
  const leases = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.url === '/v1/operations/work.claim') {
      const existing = leases.get(body.id);
      const epoch = existing ? existing.epoch + 1 : 1;
      leases.set(body.id, { claimSecret: body.claimSecret, epoch });
      return send(200, { data: { id: body.id, status: 'claimed', epoch } });
    }
    if (req.url === '/v1/operations/work.lease') {
      const current = leases.get(body.id);
      if (!current) {
        return send(404, { error: { code: 'not_found', message: 'No active lease' } });
      }
      return send(200, {
        data: { epoch: current.epoch, claimId: claimIdOf(current.claimSecret) },
      });
    }
    if (req.url === '/v1/operations/work.start') {
      const current = leases.get(body.id);
      if (!current || current.claimSecret !== body.claimSecret || current.epoch !== body.epoch) {
        return send(409, { error: { code: 'stale_lease', message: 'Lease mismatch' } });
      }
      return send(200, { data: { id: body.id, status: 'running', epoch: current.epoch } });
    }
    return send(404, { error: { code: 'not_found', message: `Unexpected ${req.url}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${address.port}`;
  return {
    apiUrl,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function writeCredentialFile(dir, apiUrl) {
  const credPath = join(dir, 'worker.json');
  await writeFile(
    credPath,
    JSON.stringify({
      apiUrl,
      token: 'test-only-opaque-token-0123456789abcdef',
      principalId: randomUUID(),
      ownerId: randomUUID(),
      scopeId: null,
    }),
    { mode: 0o600 },
  );
  return credPath;
}

test('SiftClient.fromFile respects SIFT_LEASE_DIR, enforces 0700/0600 modes, and rejects loose/symlink custody', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sift-lease-dir-test-'));
  const api = await startStubApi();
  const prevLeaseDir = process.env.SIFT_LEASE_DIR;

  try {
    const credDir = join(root, 'creds');
    await mkdir(credDir, { mode: 0o700 });
    const credPath = await writeCredentialFile(credDir, api.apiUrl);

    // 1. SIFT_LEASE_DIR points to a separate temp directory (not next to credential file).
    const customLeaseDir = join(root, 'isolated', 'leases');
    process.env.SIFT_LEASE_DIR = customLeaseDir;
    const workId = randomUUID();
    const client = await SiftClient.fromFile(credPath);

    const claimed = await client.invoke('work.claim', { id: workId }, 'claim-1');
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.epoch, 1);

    const started = await client.invoke('work.start', { id: workId }, 'start-1');
    assert.equal(started.status, 'running');
    assert.equal(started.epoch, 1);

    // Lease files must NOT be written next to the credential file.
    assert.equal(existsSync(join(credDir, 'leases')), false);

    // Created lease directory must be mode 0700 and every lease file mode 0600.
    const dirStat = await lstat(customLeaseDir);
    assert.equal(dirStat.isDirectory(), true);
    assert.equal(dirStat.mode & 0o777, 0o700);

    const files = await readdir(customLeaseDir);
    assert.ok(files.some((f) => f.endsWith('.claim.json')));
    assert.ok(files.some((f) => f.endsWith('.candidate.json')));
    assert.ok(files.some((f) => f.endsWith('.mutation.json')));
    for (const file of files) {
      const fileStat = await lstat(join(customLeaseDir, file));
      assert.equal(fileStat.isFile(), true);
      assert.equal(fileStat.mode & 0o777, 0o600);
    }

    // 2. Loose-permission lease file is rejected.
    const claimFile = join(
      customLeaseDir,
      files.find((f) => f.endsWith('.claim.json')),
    );
    await chmod(claimFile, 0o644);
    await assert.rejects(
      () => client.invoke('work.claim', { id: workId }, 'claim-1'),
      /Lease custody must be a private regular file/,
    );
    await chmod(claimFile, 0o600);

    // 3. Symlink lease file is rejected.
    const mutationFile = join(
      customLeaseDir,
      files.find((f) => f.endsWith('.mutation.json')),
    );
    const targetFile = join(root, 'symlink-target.json');
    await writeFile(targetFile, '{}', { mode: 0o600 });
    await rm(mutationFile);
    await symlink(targetFile, mutationFile);
    await assert.rejects(
      () => client.invoke('work.start', { id: workId }, 'start-1'),
      /Lease custody must be a private regular file/,
    );

    // 4. Relative SIFT_LEASE_DIR is resolved to an absolute path.
    const relTarget = join(root, 'relative-leases');
    process.env.SIFT_LEASE_DIR = relative(process.cwd(), relTarget);
    const relClient = await SiftClient.fromFile(credPath);
    const relWorkId = randomUUID();
    await relClient.invoke('work.claim', { id: relWorkId }, 'rel-claim-1');
    const relDirStat = await lstat(relTarget);
    assert.equal(relDirStat.isDirectory(), true);
    assert.equal(relDirStat.mode & 0o777, 0o700);

    // 5. Explicit leaseDir argument overrides SIFT_LEASE_DIR.
    const explicitLeaseDir = join(root, 'explicit-leases');
    const unusedEnvDir = join(root, 'unused-env-leases');
    process.env.SIFT_LEASE_DIR = unusedEnvDir;
    const explicitClient = await SiftClient.fromFile(credPath, explicitLeaseDir);
    await explicitClient.invoke('work.claim', { id: randomUUID() }, 'explicit-claim-1');
    assert.equal(existsSync(explicitLeaseDir), true);
    assert.equal(existsSync(unusedEnvDir), false);
    assert.equal((await lstat(explicitLeaseDir)).mode & 0o777, 0o700);

    // 6. Loose-permission lease directory is rejected.
    const looseDir = join(root, 'loose-dir');
    await mkdir(looseDir, { mode: 0o755 });
    await chmod(looseDir, 0o755);
    process.env.SIFT_LEASE_DIR = looseDir;
    const looseClient = await SiftClient.fromFile(credPath);
    await assert.rejects(
      () => looseClient.invoke('work.claim', { id: randomUUID() }, 'loose-dir-claim'),
      /Lease directory must be a private directory with mode 0700/,
    );

    // 7. Symlink lease directory is rejected.
    const realPrivateDir = join(root, 'real-private-dir');
    await mkdir(realPrivateDir, { mode: 0o700 });
    const symlinkDir = join(root, 'symlink-lease-dir');
    await symlink(realPrivateDir, symlinkDir);
    process.env.SIFT_LEASE_DIR = symlinkDir;
    const symlinkClient = await SiftClient.fromFile(credPath);
    await assert.rejects(
      () => symlinkClient.invoke('work.claim', { id: randomUUID() }, 'symlink-dir-claim'),
      /Lease directory must be a private directory with mode 0700/,
    );

    // 8. Empty/whitespace SIFT_LEASE_DIR falls back to join(dirname(path), 'leases').
    process.env.SIFT_LEASE_DIR = '   ';
    const defaultClient = await SiftClient.fromFile(credPath);
    await defaultClient.invoke('work.claim', { id: randomUUID() }, 'default-claim-1');
    const defaultDirStat = await lstat(join(credDir, 'leases'));
    assert.equal(defaultDirStat.isDirectory(), true);
    assert.equal(defaultDirStat.mode & 0o777, 0o700);
  } finally {
    if (prevLeaseDir === undefined) {
      delete process.env.SIFT_LEASE_DIR;
    } else {
      process.env.SIFT_LEASE_DIR = prevLeaseDir;
    }
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
});
