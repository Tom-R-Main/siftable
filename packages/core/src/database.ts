import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import {
  moduleIds,
  moduleSchema,
  SiftError,
  type ModuleId,
  type Principal,
} from '@siftable/contracts';
export { Pool };
export const digest = (v: string) => createHash('sha256').update(v).digest('hex');
export interface Manifest {
  id: ModuleId;
  version: number;
  requires: ModuleId[];
  migration: string;
  migrations?: string[];
}
export async function manifests(): Promise<Manifest[]> {
  return Promise.all(
    moduleIds.map(
      async (m) =>
        JSON.parse(
          await readFile(new URL(`./modules/${m}/manifest.json`, import.meta.url), 'utf8'),
        ) as Manifest,
    ),
  );
}
export async function planModules(selected: string[]): Promise<Manifest[]> {
  const all = await manifests();
  const included = new Set<ModuleId>(['foundation']);
  const add = (name: string) => {
    const id = moduleSchema.parse(name);
    const m = all.find((x) => x.id === id)!;
    if (included.has(id)) return;
    m.requires.forEach(add);
    included.add(id);
  };
  selected.forEach(add);
  return all.filter((x) => included.has(x.id));
}
export async function migrate(adminUrl: string, selected: string[]): Promise<Manifest[]> {
  let plan = await planModules(selected);
  const pool = new Pool({ connectionString: adminUrl });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtext('siftable-migrations'))");
    // Installation and API toggles must observe the same dependency state.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('siftable-module-state',0))");
    await c.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sift_runtime') THEN CREATE ROLE sift_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $$",
    );
    const role = (
      await c.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='sift_runtime'")
    ).rows[0];
    if (role.rolsuper || role.rolbypassrls) throw new Error('Unsafe existing sift_runtime role');
    const exists = (await c.query("SELECT to_regclass('foundation.modules') AS name")).rows[0].name;
    if (exists) {
      const installed = (await c.query('SELECT id FROM foundation.modules')).rows;
      plan = await planModules([...selected, ...installed.map((m) => m.id)]);
    }
    for (const m of plan) {
      const files = m.migrations ?? [m.migration];
      const installed =
        m.id === 'foundation' && !exists
          ? undefined
          : (await c.query('SELECT * FROM foundation.modules WHERE id=$1', [m.id])).rows[0];
      if (installed && installed.version > files.length)
        throw new Error('Database version is newer than this executable');
      for (const [index, file] of files.entries()) {
        const version = index + 1;
        const sql = await readFile(new URL(`./modules/${m.id}/${file}`, import.meta.url), 'utf8');
        const checksum = digest(sql);
        if (installed && installed.version === version && installed.checksum !== checksum)
          throw new Error(`Migration drift: ${m.id}`);
        if (version === 1 && !installed) {
          if (m.id !== 'foundation')
            await c.query('INSERT INTO foundation.modules(id,version,checksum) VALUES($1,1,$2)', [
              m.id,
              checksum,
            ]);
          await c.query(sql);
          if (m.id === 'foundation')
            await c.query('INSERT INTO foundation.modules(id,version,checksum) VALUES($1,1,$2)', [
              m.id,
              checksum,
            ]);
        }
        if (m.id === 'foundation' && version === 1) {
          await c.query(
            'CREATE TABLE IF NOT EXISTS foundation.migrations(module text NOT NULL REFERENCES foundation.modules(id), version integer NOT NULL, checksum text NOT NULL, PRIMARY KEY(module,version))',
          );
        }
        const previous = (
          await c.query(
            'SELECT checksum FROM foundation.migrations WHERE module=$1 AND version=$2',
            [m.id, version],
          )
        ).rows[0];
        if (previous && previous.checksum !== checksum)
          throw new Error(`Migration drift: ${m.id}/${file}`);
        if (!previous) {
          if (installed && installed.version > 1 && installed.version >= version)
            throw new Error('Missing migration receipt');
          if (version > 1) {
            if (installed && installed.version >= version)
              throw new Error('Missing migration receipt');
            await c.query(sql);
            await c.query('UPDATE foundation.modules SET version=$2,checksum=$3 WHERE id=$1', [
              m.id,
              version,
              checksum,
            ]);
          }
          await c.query(
            'INSERT INTO foundation.migrations(module,version,checksum) VALUES($1,$2,$3)',
            [m.id, version, checksum],
          );
        }
      }
      const current = (await c.query('SELECT version FROM foundation.modules WHERE id=$1', [m.id]))
        .rows[0];
      if (current.version !== files.length || m.version !== files.length)
        throw new Error('Inconsistent module migration version');
      const tables = await c.query(
        "SELECT table_name FROM information_schema.columns WHERE table_schema=$1 AND column_name='owner_id'",
        [m.id],
      );
      for (const { table_name: t } of tables.rows) {
        if (m.id === 'foundation' && t === 'principals') continue;
        const policy = (
          await c.query(
            'SELECT 1 FROM pg_policies WHERE schemaname=$1 AND tablename=$2 AND policyname=$3',
            [m.id, t, 'scope_isolation'],
          )
        ).rowCount;
        if (!policy)
          await c.query(
            `ALTER TABLE "${m.id}"."${t}" ENABLE ROW LEVEL SECURITY; ALTER TABLE "${m.id}"."${t}" FORCE ROW LEVEL SECURITY; CREATE POLICY scope_isolation ON "${m.id}"."${t}" USING(foundation.visible(owner_id,scope_id)) WITH CHECK(foundation.visible(owner_id,scope_id));`,
          );
      }
      await c.query(
        `GRANT USAGE ON SCHEMA "${m.id}" TO sift_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${m.id}" TO sift_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${m.id}" TO sift_runtime;`,
      );
    }
    const active = new Set(
      (await c.query<{ id: string }>('SELECT id FROM foundation.modules WHERE enabled')).rows.map(
        (m) => m.id,
      ),
    );
    for (const m of plan) {
      if (active.has(m.id) && m.requires.some((dependency) => !active.has(dependency)))
        throw new Error(`Enable required modules before installing ${m.id}`);
    }
    await c.query('REVOKE INSERT,UPDATE,DELETE ON foundation.migrations FROM sift_runtime');
    await c.query(
      'REVOKE ALL ON foundation.principals FROM sift_runtime; REVOKE ALL ON FUNCTION foundation.authenticate(text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION foundation.authenticate(text) TO sift_runtime;',
    );
    if (process.env.SIFT_RUNTIME_PASSWORD_FILE) {
      const password = (await readFile(process.env.SIFT_RUNTIME_PASSWORD_FILE, 'utf8')).trim();
      if (password.length < 32) throw new Error('Runtime password is too short');
      await c.query("SELECT set_config('sift.bootstrap_password',$1,true)", [password]);
      await c.query(
        "DO $$ BEGIN EXECUTE format('ALTER ROLE sift_runtime PASSWORD %L', current_setting('sift.bootstrap_password')); END $$",
      );
    }
    await c.query('COMMIT');
    return plan;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}
export async function savePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
}
export async function issueCredential(
  adminUrl: string,
  path: string,
  options: {
    ownerId?: string;
    scopeId?: string | null;
    role?: 'owner' | 'agent';
    permissions?: string[];
    apiUrl: string;
  },
): Promise<{
  principalId: string;
  ownerId: string;
  scopeId: string | null;
  credentialFile: string;
}> {
  const pool = new Pool({ connectionString: adminUrl });
  const id = randomUUID();
  const owner = options.ownerId ?? randomUUID();
  const token = `sift_pat_${randomBytes(32).toString('base64url')}`;
  try {
    // File is created exclusively before insertion; an existing file is never overwritten.
    await savePrivate(path, {
      apiUrl: options.apiUrl,
      token,
      principalId: id,
      ownerId: owner,
      scopeId: options.scopeId ?? null,
    });
    await pool.query(
      'INSERT INTO foundation.principals(id,owner_id,scope_id,role,token_hash,permissions) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        owner,
        options.scopeId ?? null,
        options.role ?? 'owner',
        digest(token),
        options.permissions ?? [],
      ],
    );
    return {
      principalId: id,
      ownerId: owner,
      scopeId: options.scopeId ?? null,
      credentialFile: path,
    };
  } finally {
    await pool.end();
  }
}
export async function authenticate(pool: Pool, token: string): Promise<Principal> {
  const r = await pool.query('SELECT * FROM foundation.authenticate($1)', [digest(token)]);
  const p = r.rows[0];
  if (!p) throw new SiftError(401, 'unauthorized', 'Valid local credentials required');
  return {
    id: p.id,
    ownerId: p.owner_id,
    scopeId: p.scope_id,
    role: p.role,
    permissions: p.permissions,
  };
}
export async function transaction<T>(
  pool: Pool,
  p: Principal,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.owner_id',$1,true),set_config('app.scope_id',$2,true)", [
      p.ownerId,
      p.scopeId ?? '',
    ]);
    const value = await fn(c);
    await c.query('COMMIT');
    return value;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function assertRuntimeRole(pool: Pool): Promise<void> {
  const r = (
    await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  if (r.rolsuper || r.rolbypassrls)
    throw new Error('The serving database role must not be superuser or bypass RLS');
}
export async function databaseUrlFromEnvironment(admin = false): Promise<string> {
  const key = admin ? 'SIFT_ADMIN_DATABASE_URL' : 'SIFT_DATABASE_URL';
  const file = process.env[`${key}_FILE`];
  const url = file ? (await readFile(file, 'utf8')).trim() : process.env[key];
  if (!url) throw new Error(`${key} or ${key}_FILE is required`);
  return url;
}
