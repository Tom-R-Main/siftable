// Fault injection around real PostgreSQL effects in the actual admin CLI process.
// Imported only by focused acceptance tests, never by application entrypoints.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
const require = createRequire(
  resolve(process.env.SIFT_ARTIFACT_ROOT ?? '.', 'packages/cli/dist/index.js'),
);
const { Pool, Client } = require('pg');
const query = Pool.prototype.query;
let injected = false;
Pool.prototype.query = async function (...args) {
  const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
  const stage = process.env.TEST_RESTORE_FAULT;
  if (injected && stage === 'unknown')
    throw new Error('Synthetic unavailable reconciliation connection');
  const result = await query.apply(this, args);
  if (
    !injected &&
    ((stage === 'created' && sql?.startsWith('CREATE DATABASE')) ||
      (['published', 'unknown'].includes(stage) && sql?.includes('GRANT CONNECT ON DATABASE')))
  ) {
    injected = true;
    if (stage === 'published') {
      const target = new URL(process.env.SIFT_ADMIN_DATABASE_URL);
      target.pathname = '/' + sql.match(/GRANT CONNECT ON DATABASE "([a-z0-9_]+)"/)[1];
      target.username = 'sift_runtime';
      target.password = '';
      const session = new Client({ connectionString: target.href });
      session.on('error', () => {});
      await session.connect();
      const pid = (await session.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await writeFile(process.env.TEST_RESTORE_SESSION_FILE, JSON.stringify({ pid }), {
        mode: 0o600,
      });
      // Keep this real ordinary session open; quarantine must terminate it.
    }
    throw new Error('Synthetic lost PostgreSQL response after committed effect');
  }
  return result;
};
