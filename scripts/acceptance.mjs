import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const suffix = randomUUID().slice(0, 8),
  network = `sift-test-${suffix}`,
  db = `sift-db-${suffix}`,
  runner = `sift-run-${suffix}`;
async function run(args, capture = false) {
  const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  p.stdout.on('data', (d) => {
    output += d;
    if (!capture) process.stdout.write(d);
  });
  p.stderr.on('data', (d) => {
    if (!capture) process.stderr.write(d);
  });
  const code = await new Promise((r, j) => {
    p.once('error', j);
    p.once('exit', r);
  });
  if (code !== 0) throw new Error(`Docker operation failed (${args[0]}, exit ${code})`);
  return output;
}
let createdNetwork = false,
  createdDb = false;
try {
  await run(['network', 'create', '--internal', network], true);
  createdNetwork = true;
  await run(
    [
      'run',
      '-d',
      '--name',
      db,
      '--network',
      network,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      'pgvector/pgvector:pg17',
    ],
    true,
  );
  createdDb = true;
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      await run(['exec', db, 'pg_isready', '-U', 'postgres'], true);
      ready = true;
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error('Database readiness timed out');
  const args = [
    'run',
    '--rm',
    '--name',
    runner,
    '--network',
    network,
    '-v',
    `${process.cwd()}:/workspace`,
    '-w',
    '/workspace',
    '-e',
    `TEST_ADMIN_DATABASE_URL=postgresql://postgres@${db}/postgres`,
    ...(process.env.SIFT_TEST_IMAGE ? ['-e', 'SIFT_ARTIFACT_ROOT=/app'] : []),
    process.env.SIFT_TEST_IMAGE ?? 'node:22.23.3-alpine',
    'node',
    '--test',
    '--test-concurrency=1',
    'tests/acceptance/headless.test.mjs',
  ];
  const report = await run(args);
  await mkdir('.local/validation', { recursive: true });
  await writeFile('.local/validation/headless.tap', report);
} finally {
  // Names are generated for this attempt; no unrelated container or network is touched.
  if (createdDb) await run(['rm', '-f', db], true);
  if (createdNetwork) await run(['network', 'rm', network], true);
}
