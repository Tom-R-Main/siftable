// Runs only inside the disposable README environment, as its normal Docker-capable user.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, stat, writeFile } from 'node:fs/promises';

const receipt = { startedAt: new Date().toISOString(), uid: process.getuid(), checks: [] };
function run(command, args, json = false) {
  console.log(`RUN ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`Failed ${command} ${args[0]} (${result.status})`);
  }
  if (!json) process.stdout.write(result.stdout + result.stderr);
  return json ? JSON.parse(result.stdout) : result.stdout;
}
const cli = (operation, input = {}) =>
  run(
    'node',
    [
      'packages/cli/dist/index.js',
      operation,
      '--config',
      '.local/owner.json',
      '--json',
      JSON.stringify(input),
    ],
    true,
  );
const admin = (...args) => run('docker', ['compose', 'run', '--rm', '-T', 'admin', ...args], true);
const check = (label) => {
  receipt.checks.push(label);
  console.log(`PASS ${label}`);
};
async function ready() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:8088/health', { signal: AbortSignal.timeout(2000) })).ok)
        return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Loopback readiness timed out');
}
assert.equal(process.getuid(), 10001);
for (const path of [
  '.local',
  'node_modules',
  `${process.env.HOME}/.npm`,
  `${process.env.HOME}/.docker/config.json`,
]) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}
assert.equal(process.env.SIFT_CONFIG, undefined);
const initial = run('docker', ['info', '--format', '{{json .}}'], true);
assert.equal(initial.Containers, 0);
assert.equal(initial.Images, 0);
assert.equal(run('docker', ['volume', 'ls', '-q']).trim(), '');
receipt.runtime = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  docker: initial.ServerVersion,
  compose: run('docker', ['compose', 'version', '--short']).trim(),
};
check('fresh non-root home, npm, application, Docker image/container/volume state');
const readme = await readFile('README.md', 'utf8');
for (const command of ['npm ci', 'npm run build', 'npm run local', 'npm run example:first-work'])
  assert.ok(readme.includes(command));
run('npm', ['ci']);
run('npm', ['run', 'build']);
const missing = spawnSync(
  'node',
  ['packages/cli/dist/index.js', 'catalog', '--config', '.local/owner.json'],
  { encoding: 'utf8' },
);
assert.equal(missing.status, 1);
assert.match(missing.stderr, /ENOENT/);
check('missing configuration fails before bootstrap');
run('npm', ['run', 'local']);
await ready();
for (const path of ['.local/owner.json', '.local/runtime-db-url']) {
  const s = await stat(path);
  assert.equal(s.uid, process.getuid());
  assert.equal(s.mode & 0o777, 0o600);
}
const catalog = cli('catalog');
assert.ok(catalog.some((operation) => operation.name === 'work.accept'));
receipt.identity = cli('config.info');
receipt.modules = cli('modules.list');
receipt.schemas = cli('schema.inspect');
check('README bootstrap and first CLI access with host-owned private credentials');
run('npm', ['run', 'example:first-work']);
receipt.flow = JSON.parse(await readFile('.local/first-work.json', 'utf8'));
assert.equal(receipt.flow.status, 'done');
assert.equal(receipt.flow.agentAcceptanceRefused, true);
assert.equal(receipt.flow.credentialRevoked, true);
check('CLI create/claim -> actual stdio MCP context/evidence/review -> owner CLI acceptance');
run('docker', ['compose', 'stop']);
run('docker', ['compose', 'start']);
await ready();
assert.equal(cli('work.get', { id: receipt.flow.workId }).status, 'done');
check('documented stop/start retains accepted work');
receipt.backup = admin('backup', '--output', '/run/sift/backup-001');
receipt.backupVerified = admin('backup-verify', '--file', '/run/sift/backup-001');
assert.equal(receipt.backupVerified.verified, true);
assert.equal((await stat('.local/backup-001')).uid, process.getuid());
assert.equal((await stat('.local/backup-001')).mode & 0o777, 0o700);
receipt.restore = admin(
  'restore',
  '--file',
  '/run/sift/backup-001',
  '--database',
  'siftable_recovered',
);
run('docker', ['compose', 'stop', 'server']);
// Same protected-file edit documented in README. Never emit the database URL.
const path = '.local/runtime-db-url';
const url = new URL((await readFile(path, 'utf8')).trim());
url.pathname = '/siftable_recovered';
await writeFile(path, url.href, { mode: 0o600 });
run('docker', ['compose', 'up', '-d', '--force-recreate', 'server']);
await ready();
cli('modules.list');
const recovered = cli('work.get', { id: receipt.flow.workId });
assert.equal(recovered.status, 'done');
assert.equal(recovered.coverage.state, 'commands_passed');
assert.equal(cli('notes.get', { id: receipt.flow.noteId }).revision, 1);
check('README backup/verify/restore/switch preserves actual CLI/MCP work and note');
receipt.finishedAt = new Date().toISOString();
await writeFile('/workspace/readme-receipt.json', JSON.stringify(receipt, null, 2) + '\n');
console.log('README CLEAN-ENVIRONMENT CHECK PASSED');
