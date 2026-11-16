import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const modules = process.argv[2] ?? 'projects,context,work,planning,extensions';
const port = process.env.SIFT_PORT ?? '8088';
await mkdir('.local', { recursive: true, mode: 0o700 });
async function privateFile(path, value) {
  try {
    await writeFile(path, value, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}
await privateFile('.local/postgres-password', randomBytes(32).toString('hex'));
await privateFile('.local/runtime-password', randomBytes(32).toString('hex'));
const adminPassword = await readFile('.local/postgres-password', 'utf8');
const runtimePassword = await readFile('.local/runtime-password', 'utf8');
await privateFile('.local/admin-db-url', `postgresql://postgres:${adminPassword}@db/siftable`);
await privateFile(
  '.local/runtime-db-url',
  `postgresql://sift_runtime:${runtimePassword}@db/siftable`,
);
async function run(args) {
  const child = spawn('docker', ['compose', ...args], { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Docker Compose step failed')),
    );
  });
}
await run(['build', 'server']);
await run(['up', '-d', '--wait', 'db']);
let initialized = true;
try {
  await access('.local/owner.json');
} catch {
  initialized = false;
}
await run([
  'run',
  '--rm',
  'admin',
  initialized ? 'install' : 'init',
  '--modules',
  modules,
  ...(initialized ? [] : ['--output', '/run/sift/owner.json', '--url', `http://127.0.0.1:${port}`]),
]);
await run(['up', '-d', 'server']);
let ready = false;
for (let i = 0; i < 30; i++) {
  try {
    if (
      (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok
    ) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
if (!ready) throw new Error('Server readiness failed');
console.log(
  JSON.stringify({
    status: 'ready',
    url: `http://127.0.0.1:${port}`,
    credentialFile: '.local/owner.json',
    modules,
  }),
);
