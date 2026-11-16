import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, chmod, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { canonical, moduleSchema, SiftError } from '@siftable/contracts';
import { Pool, type PoolClient } from 'pg';
import { manifests, migrate, digest } from './database.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z
  .object({
    format: z.literal('siftable-postgres-v1'),
    createdAt: z.string(),
    postgresMajor: z.literal(17),
    archiveSha256: hash,
    modules: z.array(
      z
        .object({
          id: moduleSchema,
          version: z.number().int().positive(),
          checksum: hash,
          enabled: z.boolean(),
        })
        .strict(),
    ),
    migrations: z.array(
      z
        .object({ module: moduleSchema, version: z.number().int().positive(), checksum: hash })
        .strict(),
    ),
    tables: z.array(
      z
        .object({
          schema: moduleSchema,
          table: z.string().regex(/^[a-z_]+$/),
          rows: z.number().int().nonnegative(),
          sha256: hash,
        })
        .strict(),
    ),
  })
  .strict();
const error = (code: string, message: string): never => {
  throw new SiftError(409, code, message);
};
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
async function fileHash(path: string) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}
// Never place the connection string or password in argv or error messages.
function pgEnvironment(url: string) {
  const u = new URL(url);
  if (
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    [...u.searchParams.keys()].some((k) => k !== 'sslmode')
  )
    error('backup_connection', 'Use a PostgreSQL URL with only an optional sslmode parameter');
  return {
    PATH: process.env.PATH,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGSSLMODE: u.searchParams.get('sslmode') ?? 'prefer',
    PGCONNECT_TIMEOUT: '10',
  };
}
async function pgTool(tool: 'pg_dump' | 'pg_restore', args: string[], url: string) {
  await new Promise<void>((done, reject) => {
    const child = spawn(tool, args, {
      env: pgEnvironment(url),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    // Database diagnostics can contain user content. Suppress them at this boundary.
    child.stderr.resume();
    child.once('error', () =>
      reject(
        new SiftError(
          409,
          'postgres_tool',
          `${tool} could not start; PostgreSQL 17 client tools are required`,
        ),
      ),
    );
    child.once('exit', (code) =>
      code === 0
        ? done()
        : reject(
            new SiftError(
              409,
              'postgres_tool',
              `${tool} failed; no successful recovery is claimed`,
            ),
          ),
    );
  });
}
async function state(c: PoolClient) {
  await c.query("SET LOCAL TIME ZONE 'UTC'");
  const modules = (
    await c.query('SELECT id,version,checksum,enabled FROM foundation.modules ORDER BY id')
  ).rows;
  const migrations = (
    await c.query(
      'SELECT module,version,checksum FROM foundation.migrations ORDER BY module,version',
    )
  ).rows;
  const catalog = (
    await c.query(
      'SELECT schemaname AS schema,tablename AS table FROM pg_tables WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,tablename',
      [modules.map((m) => m.id)],
    )
  ).rows;
  const tables = [];
  // Bounded client memory, stable order, unambiguous newline-delimited JSONB rows.
  for (const t of catalog) {
    const h = createHash('sha256');
    let rows = 0;
    await c.query(
      `DECLARE backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM ${quote(t.schema)}.${quote(t.table)} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
    );
    for (;;) {
      const batch = await c.query<{ row: string }>('FETCH 500 FROM backup_rows');
      for (const record of batch.rows) {
        h.update(record.row + '\n');
        rows++;
      }
      if (!batch.rowCount) break;
    }
    await c.query('CLOSE backup_rows');
    tables.push({ schema: t.schema, table: t.table, rows, sha256: h.digest('hex') });
  }
  return { modules, migrations, tables };
}
async function compatible(m: z.infer<typeof manifestSchema>) {
  const bundled = await manifests();
  if (
    !m.modules.some((x) => x.id === 'foundation') ||
    new Set(m.modules.map((x) => x.id)).size !== m.modules.length
  )
    error('backup_manifest', 'Invalid module inventory');
  for (const module of m.modules) {
    const known = bundled.find((x) => x.id === module.id)!;
    // Recovery uses the exact schema release. Upgrade separately after recovery.
    if (module.version !== known.version)
      error(
        'backup_version',
        'Restore requires the executable matching the backup schema versions',
      );
    const files = known.migrations ?? [known.migration];
    for (const [i, file] of files.entries()) {
      const checksum = digest(
        await readFile(new URL(`./modules/${module.id}/${file}`, import.meta.url), 'utf8'),
      );
      if (
        !m.migrations.some(
          (x) => x.module === module.id && x.version === i + 1 && x.checksum === checksum,
        )
      )
        error('backup_migration', 'Backup migration checksums do not match this executable');
      if (i === files.length - 1 && module.checksum !== checksum)
        error('backup_migration', 'Module version checksum is invalid');
    }
    if (known.requires.some((dep) => !m.modules.some((x) => x.id === dep)))
      error('backup_manifest', 'A required module is missing');
  }
}
export async function backupDatabase(url: string, directory: string) {
  const path = resolve(directory);
  // A new directory is the backup identity. Never replace a previous backup.
  await mkdir(path, { mode: 0o700 });
  const pool = new Pool({ connectionString: url });
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock_shared(hashtext('siftable-migrations'))");
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const major = Math.floor(
      Number((await c.query('SHOW server_version_num')).rows[0].server_version_num) / 10000,
    );
    if (major !== 17)
      error('backup_version', 'This recovery contract currently supports PostgreSQL 17');
    const snapshot = (await c.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const inventory = await state(c);
    const archive = join(path, 'database.dump');
    await writeFile(archive, '', { flag: 'wx', mode: 0o600 });
    await pgTool(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-acl',
        `--snapshot=${snapshot}`,
        `--file=${archive}`,
        ...inventory.modules.map((m) => `--schema=${m.id}`),
      ],
      url,
    );
    await chmod(archive, 0o600);
    const manifest = manifestSchema.parse({
      format: 'siftable-postgres-v1',
      createdAt: new Date().toISOString(),
      postgresMajor: 17,
      archiveSha256: await fileHash(archive),
      ...inventory,
    });
    await compatible(manifest);
    await c.query('COMMIT');
    // Completion marker is written last. Incomplete directories cannot be restored.
    await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return {
      backup: path,
      sha256: manifest.archiveSha256,
      modules: manifest.modules.map((m) => m.id),
      tables: manifest.tables.length,
      rows: manifest.tables.reduce((n, t) => n + t.rows, 0),
    };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.query("SELECT pg_advisory_unlock_shared(hashtext('siftable-migrations'))");
    c.release();
    await pool.end();
  }
}
export async function verifyBackup(directory: string) {
  const path = resolve(directory);
  for (const name of ['', 'manifest.json', 'database.dump']) {
    const info = await lstat(join(path, name));
    if (info.isSymbolicLink() || (name ? !info.isFile() : !info.isDirectory()) || info.mode & 0o077)
      error(
        'backup_permissions',
        'Backup directory and files must be private and must not be symlinks',
      );
  }
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')),
  );
  if ((await fileHash(join(path, 'database.dump'))) !== manifest.archiveSha256)
    error('backup_checksum', 'Backup archive checksum mismatch');
  await compatible(manifest);
  return manifest;
}
export async function restoreDatabase(adminUrl: string, directory: string, database: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database))
    error(
      'restore_name',
      'Use a new database name containing lowercase letters, digits and underscores',
    );
  const manifest = await verifyBackup(directory);
  const admin = new Pool({ connectionString: adminUrl });
  const target = new URL(adminUrl);
  target.pathname = '/' + database;
  let created = false;
  let creationAttempted = false;
  try {
    const major = Math.floor(
      Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) / 10000,
    );
    if (major !== manifest.postgresMajor)
      error('backup_version', 'Target PostgreSQL major must match the backup');
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount)
      error('restore_exists', 'Restore refuses an existing database; choose a new name');
    // CONNECTION LIMIT 0 excludes ordinary sessions from the first committed
    // creation effect. Only the trusted superuser can restore while quarantined.
    const role = (await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user'))
      .rows[0];
    if (!role?.rolsuper)
      error(
        'restore_admin',
        'Restore requires a PostgreSQL superuser to keep the new database quarantined',
      );
    creationAttempted = true;
    await admin.query(`CREATE DATABASE ${quote(database)} TEMPLATE template0 CONNECTION LIMIT 0`);
    created = true;
    await admin.query(`REVOKE CONNECT ON DATABASE ${quote(database)} FROM PUBLIC`);
    await pgTool(
      'pg_restore',
      [
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '--single-transaction',
        `--dbname=${database}`,
        join(resolve(directory), 'database.dump'),
      ],
      target.toString(),
    );
    const pool = new Pool({ connectionString: target.toString() });
    const c = await pool.connect();
    let invalidatedLeases = 0;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const actual = await state(c);
      if (
        canonical(actual) !==
        canonical({
          modules: manifest.modules,
          migrations: manifest.migrations,
          tables: manifest.tables,
        })
      )
        error('restore_integrity', 'Restored records differ from the backup manifest');
      if (manifest.modules.some((m) => m.id === 'work')) {
        const leased = (
          await c.query(
            "SELECT id,owner_id,scope_id,claim_principal FROM work.items WHERE status IN ('claimed','running')",
          )
        ).rows;
        for (const w of leased)
          await c.query(
            "INSERT INTO work.events(owner_id,scope_id,work_id,actor,event,detail) VALUES($1,$2,$3,$4,'restore.lease_invalidated',$5)",
            [
              w.owner_id,
              w.scope_id,
              w.id,
              w.claim_principal,
              JSON.stringify({
                reason: 'Restored into a new database; claim again with a new request key',
              }),
            ],
          );
        invalidatedLeases =
          (
            await c.query(
              "UPDATE work.items SET status='queued',epoch=epoch+1,revision=revision+1,claim_principal=NULL,claim_digest=NULL,expires_at=NULL WHERE status IN ('claimed','running')",
            )
          ).rowCount ?? 0;
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
      await pool.end();
    }
    // Reapply grants explicitly: pg_dump intentionally excludes cluster roles and ACLs.
    await migrate(
      target.toString(),
      manifest.modules.map((m) => m.id),
    );
    // Publish access atomically only after integrity, lease invalidation and grants.
    await admin.query(
      `GRANT CONNECT ON DATABASE ${quote(database)} TO sift_runtime; ALTER DATABASE ${quote(database)} CONNECTION LIMIT -1`,
    );
    return {
      database,
      integrity: 'verified',
      modules: manifest.modules.map((m) => m.id),
      tables: manifest.tables.length,
      invalidatedLeases,
      credentials:
        'Existing protected credential files can be repointed, or issue new credentials for the restored owner/scope',
    };
  } catch (e) {
    if (created) {
      let quarantined = false;
      try {
        // A publication response may be lost after commit. Reconcile instead of
        // claiming the earlier quarantine is still in effect. No database is dropped.
        await admin.query(
          `ALTER DATABASE ${quote(database)} CONNECTION LIMIT 0; REVOKE CONNECT ON DATABASE ${quote(database)} FROM PUBLIC`,
        );
        const runtimeExists = (
          await admin.query("SELECT 1 FROM pg_roles WHERE rolname='sift_runtime'")
        ).rowCount;
        if (runtimeExists)
          await admin.query(`REVOKE CONNECT ON DATABASE ${quote(database)} FROM sift_runtime`);
        await admin.query(
          'SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid() AND usesysid NOT IN (SELECT oid FROM pg_roles WHERE rolsuper)',
          [database],
        );
        const state = (
          await admin.query('SELECT datconnlimit FROM pg_database WHERE datname=$1', [database])
        ).rows[0];
        const sessions = await admin.query(
          'SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND usesysid NOT IN (SELECT oid FROM pg_roles WHERE rolsuper)',
          [database],
        );
        quarantined = state?.datconnlimit === 0 && sessions.rowCount === 0;
      } catch {
        /* Connection failures leave access unknown, never assumed closed. */
      }
      throw new SiftError(
        409,
        'restore_incomplete',
        `Recovery did not complete. Database ${database} is retained for inspection; ${quarantined ? 'non-superuser access is disabled and existing non-superuser sessions were terminated' : 'access state is unknown; inspect and quarantine it before use'}; no successful recovery is claimed`,
      );
    }
    if (creationAttempted)
      error(
        'restore_unknown',
        `Database creation outcome for ${database} is unknown; inspect that name before retrying. No existing database was modified by recovery cleanup`,
      );
    throw e;
  } finally {
    await admin.end();
  }
}
