// Packages a committed source tree only. Never mounts the host Docker socket or home.
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const id = randomUUID().slice(0, 8);
const name = `sift-readme-${id}`;
const image = `siftable-readme-runner:${id}`;
const output = resolve(`.local/readme-${id}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const log = `${output}/run.log`;
async function run(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await appendFile(log, `$ ${command} ${args.join(' ')}\n${stdout}${stderr}\n`, { mode: 0o600 });
  if (code !== 0) throw new Error(`${command} ${args[0]} failed (${code}); inspect ${log}`);
  return stdout.trim();
}
let created = false;
try {
  const head = await run('git', ['rev-parse', 'HEAD']);
  const archive = `${output}/source.tar`;
  await run('git', ['archive', '--format=tar', `--output=${archive}`, head]);
  const source = {
    head,
    archiveSha256: createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
  };
  await writeFile(`${output}/source.json`, JSON.stringify(source, null, 2) + '\n');
  console.log(`Testing committed ${head}; uncommitted edits are excluded. Evidence: ${output}`);
  // Build the harness from that same archive rather than a possibly dirty worktree.
  await mkdir(`${output}/harness`);
  await run('tar', ['-xf', archive, '-C', `${output}/harness`, 'scripts/cleanroom/Dockerfile']);
  await run('docker', ['build', '-t', image, `${output}/harness/scripts/cleanroom`]);
  console.log('Starting fresh Linux daemon and non-root home; no host mounts or published ports.');
  await run('docker', ['run', '-d', '--privileged', '--name', name, image]);
  created = true;
  await run('docker', ['cp', archive, `${name}:/tmp/source.tar`]);
  await run('docker', [
    'exec',
    name,
    'sh',
    '-ec',
    'for i in $(seq 1 60); do if docker info >/dev/null 2>&1; then chown root:10001 /var/run/docker.sock; chmod 660 /var/run/docker.sock; exit 0; fi; sleep 1; done; exit 1',
  ]);
  await run('docker', [
    'exec',
    '--user',
    '10001:10001',
    '-e',
    'HOME=/home/newcomer',
    name,
    'tar',
    '-xf',
    '/tmp/source.tar',
  ]);
  console.log(
    'Running README install, CLI/MCP example, restart and recovery (downloads may take several minutes).',
  );
  await run('docker', [
    'exec',
    '--user',
    '10001:10001',
    '-e',
    'HOME=/home/newcomer',
    name,
    'node',
    'scripts/cleanroom/verify.mjs',
  ]);
  await run('docker', ['cp', `${name}:/workspace/readme-receipt.json`, `${output}/receipt.json`]);
  console.log(`PASS: ${output}/receipt.json`);
} finally {
  // Only this randomly named disposable environment and its anonymous volumes.
  if (created) await run('docker', ['rm', '-fv', name]);
  // The tagged harness is regenerable; avoid retaining one image per gate run.
  await run('docker', ['image', 'rm', image]).catch(() => {});
}
