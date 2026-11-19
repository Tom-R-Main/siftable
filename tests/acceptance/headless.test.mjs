import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, cp, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { Pool } from 'pg';
import { SiftClient, readCredentials } from '../../packages/client/dist/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const exec = promisify(execFile);
const adminBase = process.env.TEST_ADMIN_DATABASE_URL;
if (!adminBase)
  throw new Error('Set TEST_ADMIN_DATABASE_URL to an isolated disposable PostgreSQL cluster');
const root = resolve('.');
const artifacts = process.env.SIFT_ARTIFACT_ROOT ?? root;
const runId = randomUUID().replaceAll('-', '');
const base = resolve('.local/acceptance', runId);
await mkdir(base, { recursive: true, mode: 0o700 });
const fixtures = [];
async function cli(args, admin) {
  const { stdout } = await exec(
    process.execPath,
    [resolve(artifacts, 'packages/cli/dist/index.js'), ...args],
    {
      cwd: root,
      env: { PATH: process.env.PATH, ...(admin ? { SIFT_ADMIN_DATABASE_URL: admin } : {}) },
      maxBuffer: 2_000_000,
    },
  );
  return JSON.parse(stdout);
}
async function start(f) {
  const child = spawn(process.execPath, [resolve(artifacts, 'apps/server/dist/index.js')], {
    cwd: root,
    env: { PATH: process.env.PATH, SIFT_DATABASE_URL: f.runtimeUrl, PORT: String(f.port ?? 0) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server readiness timed out')), 10000);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Server exited before readiness'));
    });
    child.stdout.on('data', (d) => {
      output += d;
      const line = output.split('\n')[0];
      try {
        const r = JSON.parse(line);
        if (r.status === 'listening') {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${r.address.port}`);
        }
      } catch {}
    });
  });
  f.child = child;
  f.url = url;
  for (const path of f.credentials) {
    const config = JSON.parse(await readFile(path, 'utf8'));
    config.apiUrl = url;
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  }
  f.owner = await SiftClient.fromFile(f.ownerPath);
}
async function stop(f) {
  if (f.child?.exitCode === null) {
    const ended = once(f.child, 'exit');
    f.child.kill('SIGTERM');
    await ended;
  }
}
async function fixture(label, modules, legacy = false) {
  const db = `sift_${label}_${runId}`;
  const admin = new Pool({ connectionString: adminBase });
  await admin.query(`CREATE DATABASE "${db}"`);
  await admin.end();
  const u = new URL(adminBase);
  u.pathname = '/' + db;
  const adminUrl = u.href;
  u.username = 'sift_runtime';
  u.password = '';
  const runtimeUrl = u.href;
  const dir = resolve(base, label);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const f = {
    db,
    dir,
    adminUrl,
    runtimeUrl,
    ownerPath: resolve(dir, 'owner.json'),
    credentials: [],
  };
  fixtures.push(f);
  if (legacy) {
    const pool = new Pool({ connectionString: adminUrl });
    try {
      for (const mod of ['foundation', ...modules]) {
        const sql = await readFile(resolve(root, `modules/${mod}/001.sql`), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        if (mod !== 'foundation')
          await pool.query('INSERT INTO foundation.modules(id,version,checksum) VALUES($1,1,$2)', [
            mod,
            checksum,
          ]);
        await pool.query(sql);
        if (mod === 'foundation')
          await pool.query('INSERT INTO foundation.modules(id,version,checksum) VALUES($1,1,$2)', [
            mod,
            checksum,
          ]);
      }
      f.legacyProject = randomUUID();
      const owner = randomUUID();
      await pool.query(
        "INSERT INTO foundation.entities(id,owner_id,type) VALUES($1,$2,'projects.project')",
        [f.legacyProject, owner],
      );
      await pool.query(
        "INSERT INTO projects.projects(id,owner_id,title,instructions) VALUES($1,$2,'Preserved version one project','Do not rewrite history')",
        [f.legacyProject, owner],
      );
    } finally {
      await pool.end();
    }
  }
  f.identity = await cli(
    ['init', '--modules', modules.join(','), '--output', f.ownerPath],
    adminUrl,
  );
  f.credentials.push(f.ownerPath);
  await start(f);
  return f;
}
async function agent(f, name, permissions, extra = {}) {
  const path = resolve(f.dir, `${name}.json`);
  await cli(
    [
      'credential',
      '--owner-id',
      extra.ownerId ?? f.identity.ownerId,
      '--role',
      'agent',
      '--permissions',
      permissions.join(','),
      '--output',
      path,
      '--url',
      f.url,
      ...(extra.scopeId ? ['--scope-id', extra.scopeId] : []),
    ],
    f.adminUrl,
  );
  f.credentials.push(path);
  return { path, client: await SiftClient.fromFile(path) };
}
const invoke = (client, name, args = {}, key = randomUUID()) => client.invoke(name, args, key);
const reject = async (fn, code) => assert.rejects(fn, (e) => e.code === code, `Expected ${code}`);
const createWork = (client, extra = {}) =>
  invoke(client, 'work.create', {
    title: 'Prove the boundary',
    steps: [{ key: 'check', title: 'Observable result', required: true }],
    ...extra,
  });
const callCli = (f, name, args, key = randomUUID(), path = f.ownerPath) =>
  cli([name, '--config', path, '--json', JSON.stringify(args), '--key', key]);
const parseTool = (r) => {
  assert.equal(r.isError, undefined, JSON.stringify(r.content));
  return r.structuredContent.data;
};

test('standalone headless acceptance on real PostgreSQL and subprocess clients', async (t) => {
  try {
    await t.test(
      'context-only, work-only and extension-only have physically independent schemas',
      async () => {
        for (const module of ['context', 'work', 'extensions']) {
          const f = await fixture(module, [module]);
          const db = new Pool({ connectionString: f.adminUrl });
          const schemas = (
            await db.query(
              "SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('foundation','projects','context','work','planning','extensions') ORDER BY schema_name",
            )
          ).rows.map((r) => r.schema_name);
          assert.deepEqual(schemas, ['foundation', module].sort());
          const catalog = await f.owner.catalog();
          assert.ok(catalog.every((x) => ['foundation', module].includes(x.module)));
          if (module === 'context') {
            const n = await callCli(f, 'notes.create', {
              title: 'Local search',
              body: 'Persistence survives without embeddings',
            });
            assert.equal(
              (await invoke(f.owner, 'notes.search', { query: 'persistence' }))[0].id,
              n.id,
            );
            await reject(() => createWork(f.owner), 'module_unavailable');
          } else if (module === 'work') {
            await createWork(f.owner);
            await reject(() => createWork(f.owner, { projectId: randomUUID() }), 'not_found');
            await reject(
              () => invoke(f.owner, 'notes.search', { query: 'anything' }),
              'module_unavailable',
            );
          } else {
            await reject(
              () =>
                invoke(f.owner, 'relations.define', {
                  type: 'research.supports',
                  sourceType: 'projects.project',
                  targetType: 'work.item',
                }),
              'unknown_type',
            );
          }
          await db.end();
          await stop(f);
        }
      },
    );
    await t.test(
      'version one data upgrades in place and migration drift fails closed',
      async () => {
        const legacy = await fixture(
          'legacy',
          ['projects', 'context', 'work', 'planning', 'extensions'],
          true,
        );
        const pool = new Pool({ connectionString: legacy.adminUrl });
        try {
          assert.equal(
            (
              await pool.query('SELECT revision FROM projects.projects WHERE id=$1', [
                legacy.legacyProject,
              ])
            ).rows[0].revision,
            1,
          );
          assert.equal(
            (await pool.query('SELECT count(*)::int AS n FROM foundation.migrations')).rows[0].n,
            15,
          );
          assert.ok(
            (await callCli(legacy, 'modules.list', {})).every(
              (m) =>
                m.version ===
                (m.id === 'projects' || m.id === 'context' || m.id === 'work' ? 3 : 2),
            ),
          );
          await cli(['install', '--modules', 'context'], legacy.adminUrl);
          const checksum = (
            await pool.query(
              "SELECT checksum FROM foundation.migrations WHERE module='work' AND version=1",
            )
          ).rows[0].checksum;
          await pool.query(
            "UPDATE foundation.migrations SET checksum='drift' WHERE module='work' AND version=1",
          );
          await assert.rejects(() => cli(['install', '--modules', 'work'], legacy.adminUrl));
          await pool.query(
            "UPDATE foundation.migrations SET checksum=$1 WHERE module='work' AND version=1",
            [checksum],
          );
          const currentChecksum = (
            await pool.query("SELECT checksum FROM foundation.modules WHERE id='work'")
          ).rows[0].checksum;
          await pool.query("UPDATE foundation.modules SET checksum='drift' WHERE id='work'");
          await assert.rejects(() => cli(['install', '--modules', 'work'], legacy.adminUrl));
          await pool.query("UPDATE foundation.modules SET checksum=$1 WHERE id='work'", [
            currentChecksum,
          ]);
          await pool.query("DELETE FROM foundation.migrations WHERE module='work' AND version=1");
          await assert.rejects(() => cli(['install', '--modules', 'work'], legacy.adminUrl));
          await pool.query(
            "INSERT INTO foundation.migrations(module,version,checksum) VALUES('work',1,$1)",
            [checksum],
          );
          assert.equal(
            (
              await pool.query('SELECT title FROM projects.projects WHERE id=$1', [
                legacy.legacyProject,
              ])
            ).rows[0].title,
            'Preserved version one project',
          );
        } finally {
          await pool.end();
          await stop(legacy);
        }
      },
    );
    await t.test('install refuses disabled prerequisites atomically', async () => {
      const isolated = await fixture('dependency_guard', ['projects']);
      const project = await callCli(isolated, 'projects.create', { title: 'Dependency probe' });
      await callCli(isolated, 'modules.set', { module: 'projects', enabled: false });
      const db = new Pool({ connectionString: isolated.adminUrl });
      try {
        await assert.rejects(() => cli(['install', '--modules', 'planning'], isolated.adminUrl));
        assert.equal(
          (await db.query("SELECT to_regnamespace('planning') AS name")).rows[0].name,
          null,
        );
        assert.equal(
          (await db.query("SELECT enabled FROM foundation.modules WHERE id='projects'")).rows[0]
            .enabled,
          false,
        );
        await callCli(isolated, 'modules.set', { module: 'projects', enabled: true });
        await cli(['install', '--modules', 'planning'], isolated.adminUrl);
        const task = await callCli(isolated, 'tasks.create', {
          title: 'Valid dependent',
          projectId: project.id,
        });
        assert.equal(
          (await callCli(isolated, 'tasks.get', { id: task.id })).project_id,
          project.id,
        );
      } finally {
        await db.end();
        await stop(isolated);
      }
    });
    await t.test('historical claim retry preserves newer CLI lease custody', async () => {
      const isolated = await fixture('custody_guard', ['work']);
      const worker = await agent(isolated, 'worker', ['work:read', 'work:write']);
      try {
        const item = await createWork(isolated.owner);
        const old = await callCli(isolated, 'work.claim', { id: item.id }, 'claim-a', worker.path);
        await callCli(isolated, 'work.release', { id: item.id }, 'release-a', worker.path);
        const current = await callCli(
          isolated,
          'work.claim',
          { id: item.id },
          'claim-b',
          worker.path,
        );
        assert.ok(current.epoch > old.epoch);
        const replay = await callCli(
          isolated,
          'work.claim',
          { id: item.id },
          'claim-a',
          worker.path,
        );
        assert.deepEqual(replay, old);
        assert.equal(
          (await callCli(isolated, 'work.start', { id: item.id }, 'start-b', worker.path)).epoch,
          current.epoch,
        );
      } finally {
        await stop(isolated);
      }
    });
    await t.test('module installation serializes against dependency disable', async () => {
      const isolated = await fixture('module_race', ['projects']);
      const db = new Pool({ connectionString: isolated.adminUrl });
      const lock = await db.connect();
      let install, disable;
      const settled = (promise) =>
        promise.then(
          () => true,
          () => false,
        );
      try {
        await lock.query('BEGIN');
        await lock.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('siftable-module-state',0))",
        );
        install = settled(cli(['install', '--modules', 'planning'], isolated.adminUrl));
        const waiters = async (count) => {
          for (let i = 0; i < 200; i++) {
            const n = (
              await db.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%siftable-module-state%' ",
              )
            ).rows[0].n;
            if (n >= count) return;
            await new Promise((r) => setTimeout(r, 25));
          }
          assert.fail('Module operations did not wait on the common state lock');
        };
        await waiters(1);
        disable = settled(callCli(isolated, 'modules.set', { module: 'projects', enabled: false }));
        await waiters(2);
        await lock.query('COMMIT');
        const results = await Promise.all([install, disable]);
        assert.equal(results.filter(Boolean).length, 1);
        const states = Object.fromEntries(
          (await db.query('SELECT id,enabled FROM foundation.modules')).rows.map((m) => [
            m.id,
            m.enabled,
          ]),
        );
        assert.ok(!states.planning || states.projects);
      } finally {
        await lock.query('ROLLBACK');
        lock.release();
        await Promise.all([install, disable]);
        await db.end();
        await stop(isolated);
      }
    });
    await t.test('lease resolver preserves write-only scopes and mutation retries', async () => {
      const isolated = await fixture('lease_permissions', ['work']);
      const worker = await agent(isolated, 'writer', ['work:write']);
      const other = await agent(isolated, 'other', ['work:write']);
      const reader = await agent(isolated, 'reader', ['work:read']);
      const scoped = await agent(isolated, 'scoped', ['work:write'], { scopeId: randomUUID() });
      try {
        const item = await createWork(isolated.owner);
        await callCli(isolated, 'work.claim', { id: item.id }, 'scope-claim', worker.path);
        const lease = await invoke(worker.client, 'work.lease', { id: item.id });
        assert.deepEqual(Object.keys(lease).sort(), ['claimId', 'epoch']);
        await reject(() => invoke(worker.client, 'work.get', { id: item.id }), 'forbidden');
        await reject(() => invoke(reader.client, 'work.lease', { id: item.id }), 'forbidden');
        await reject(() => invoke(other.client, 'work.lease', { id: item.id }), 'stale_lease');
        await reject(() => invoke(isolated.owner, 'work.lease', { id: item.id }), 'stale_lease');
        await reject(() => invoke(scoped.client, 'work.lease', { id: item.id }), 'not_found');
        const started = await callCli(
          isolated,
          'work.start',
          { id: item.id },
          'replay-start',
          worker.path,
        );
        const released = await callCli(
          isolated,
          'work.release',
          { id: item.id },
          'replay-release',
          worker.path,
        );
        assert.deepEqual(
          await callCli(isolated, 'work.release', { id: item.id }, 'replay-release', worker.path),
          released,
        );
        await callCli(isolated, 'work.claim', { id: item.id }, 'scope-next', worker.path);
        assert.deepEqual(
          await callCli(isolated, 'work.start', { id: item.id }, 'replay-start', worker.path),
          started,
        );
        assert.deepEqual(
          await callCli(isolated, 'work.release', { id: item.id }, 'replay-release', worker.path),
          released,
        );
        assert.equal(
          (await callCli(isolated, 'work.start', { id: item.id }, 'new-start', worker.path)).epoch,
          2,
        );
      } finally {
        await stop(isolated);
      }
    });
    await t.test(
      'pre-upgrade lease files can replay released mutations and adopt a fresh claim',
      async () => {
        const isolated = await fixture('legacy_custody', ['work']);
        const worker = await agent(isolated, 'worker', ['work:write']);
        const item = await createWork(isolated.owner);
        const secret = randomBytes(32).toString('base64url');
        try {
          const claim = await worker.client.call(
            'work.claim',
            { id: item.id, claimSecret: secret },
            'legacy-claim',
          );
          const identity = await readCredentials(worker.path);
          const dir = resolve(isolated.dir, 'leases');
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const hash = (value) => createHash('sha256').update(value).digest('hex');
          await writeFile(
            resolve(dir, hash(`${isolated.url}:${identity.principalId}:${item.id}`) + '.json'),
            JSON.stringify({ claimSecret: secret, epoch: claim.epoch }),
            { mode: 0o600 },
          );
          await writeFile(
            resolve(dir, hash(`${identity.principalId}:${item.id}:legacy-claim`) + '.claim.json'),
            JSON.stringify({ claimSecret: secret }),
            { mode: 0o600 },
          );
          const released = await worker.client.call(
            'work.release',
            { id: item.id, claimSecret: secret, epoch: claim.epoch },
            'legacy-release',
          );
          assert.deepEqual(
            await callCli(isolated, 'work.release', { id: item.id }, 'legacy-release', worker.path),
            released,
          );
          assert.deepEqual(
            await callCli(isolated, 'work.claim', { id: item.id }, 'legacy-claim', worker.path),
            claim,
          );
          const fresh = await callCli(
            isolated,
            'work.claim',
            { id: item.id },
            'new-claim',
            worker.path,
          );
          assert.equal(
            (await callCli(isolated, 'work.start', { id: item.id }, 'new-start', worker.path))
              .epoch,
            fresh.epoch,
          );
        } finally {
          await stop(isolated);
        }
      },
    );
    await t.test('delayed claim response cannot replace newer custody', async () => {
      const isolated = await fixture('delayed_claim', ['work']);
      const worker = await agent(isolated, 'worker', ['work:write']);
      const item = await createWork(isolated.owner);
      const fetch = globalThis.fetch;
      let received, deliver;
      const committed = new Promise((r) => {
        received = r;
      });
      const gate = new Promise((r) => {
        deliver = r;
      });
      let old;
      try {
        globalThis.fetch = async (...args) => {
          const response = await fetch(...args);
          if (args[1]?.headers?.['Idempotency-Key'] === 'delayed-first') {
            received();
            await gate;
          }
          return response;
        };
        old = invoke(worker.client, 'work.claim', { id: item.id }, 'delayed-first');
        let timeout;
        try {
          await Promise.race([
            committed,
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Claim did not reach the response barrier')),
                10000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        // Separate CLI processes can use persisted custody before the first response arrives.
        await callCli(isolated, 'work.release', { id: item.id }, 'delay-release', worker.path);
        const current = await callCli(
          isolated,
          'work.claim',
          { id: item.id },
          'delay-next',
          worker.path,
        );
        deliver();
        await old;
        assert.equal(
          (await callCli(isolated, 'work.start', { id: item.id }, 'delay-start', worker.path))
            .epoch,
          current.epoch,
        );
      } finally {
        deliver();
        await old?.catch(() => {});
        globalThis.fetch = fetch;
        await stop(isolated);
      }
    });
    await t.test(
      'same-endpoint restore permits lower and reused epochs with existing custody',
      async () => {
        const source = await fixture('epoch_restore', ['work']);
        const worker = await agent(source, 'worker', ['work:write']);
        const item = await createWork(source.owner);
        await callCli(source, 'work.claim', { id: item.id }, 'snapshot-claim', worker.path);
        await callCli(source, 'work.release', { id: item.id }, 'snapshot-release', worker.path);
        const backup = resolve(base, 'epoch-backup');
        await cli(['backup', '--output', backup], source.adminUrl);
        for (let i = 0; i < 2; i++) {
          await callCli(source, 'work.claim', { id: item.id }, `later-claim-${i}`, worker.path);
          await callCli(source, 'work.release', { id: item.id }, `later-release-${i}`, worker.path);
        }
        const db = `sift_epoch_recovered_${runId}`;
        await cli(['restore', '--file', backup, '--database', db], adminBase);
        fixtures.push({ db });
        source.port = new URL(source.url).port;
        const sameUrl = source.url;
        await stop(source);
        const target = new URL(source.runtimeUrl);
        target.pathname = '/' + db;
        source.runtimeUrl = target.href;
        await start(source);
        assert.equal(source.url, sameUrl);
        try {
          const fresh = await callCli(
            source,
            'work.claim',
            { id: item.id },
            'after-restore',
            worker.path,
          );
          assert.equal(fresh.epoch, 2);
          await callCli(source, 'work.claim', { id: item.id }, 'snapshot-claim', worker.path);
          assert.equal(
            (await callCli(source, 'work.start', { id: item.id }, 'restored-start', worker.path))
              .epoch,
            2,
          );
        } finally {
          await stop(source);
        }
      },
    );
    await t.test(
      'restore reconciles lost creation and publish responses without false quarantine',
      async (t) => {
        const source = await fixture('restore_fault', ['context']);
        const backup = resolve(base, 'fault-backup');
        await cli(['backup', '--output', backup], source.adminUrl);
        await stop(source);
        const admin = new Pool({ connectionString: adminBase });
        try {
          await t.test('non-superuser prerequisite refuses before creating a target', async () => {
            const role = `restore_admin_${runId}`;
            const db = `sift_unprivileged_${runId}`;
            await admin.query(`CREATE ROLE "${role}" LOGIN CREATEDB CREATEROLE NOSUPERUSER`);
            try {
              const url = new URL(adminBase);
              url.username = role;
              url.password = '';
              await assert.rejects(
                () => cli(['restore', '--file', backup, '--database', db], url.href),
                (e) => /requires a PostgreSQL superuser/.test(e.stderr),
              );
              assert.equal(
                (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [db])).rowCount,
                0,
              );
            } finally {
              await admin.query(`DROP ROLE "${role}"`);
            }
          });
          for (const stage of ['created', 'published', 'unknown'])
            await t.test(stage, async () => {
              const db = `sift_fault_${stage}_${runId}`;
              fixtures.push({ db });
              await assert.rejects(
                () =>
                  exec(
                    process.execPath,
                    [
                      '--import',
                      resolve(root, 'tests/acceptance/restore-fault.mjs'),
                      resolve(artifacts, 'packages/cli/dist/index.js'),
                      'restore',
                      '--file',
                      backup,
                      '--database',
                      db,
                    ],
                    {
                      env: {
                        PATH: process.env.PATH,
                        SIFT_ADMIN_DATABASE_URL: adminBase,
                        SIFT_ARTIFACT_ROOT: artifacts,
                        TEST_RESTORE_FAULT: stage,
                        TEST_RESTORE_SESSION_FILE: resolve(base, 'restore-session.json'),
                      },
                    },
                  ),
                (error) =>
                  stage === 'unknown'
                    ? /access state is unknown/.test(error.stderr)
                    : stage === 'created'
                      ? /creation outcome.*unknown/.test(error.stderr)
                      : /non-superuser access is disabled/.test(error.stderr),
              );
              const state = (
                await admin.query(
                  "SELECT datconnlimit,has_database_privilege('sift_runtime',datname,'CONNECT') AS allowed FROM pg_database WHERE datname=$1",
                  [db],
                )
              ).rows[0];
              assert.ok(state);
              if (stage === 'created')
                assert.equal(
                  state.datconnlimit,
                  0,
                  'Creation itself must quarantine non-superuser connections',
                );
              else if (stage === 'unknown') assert.equal(state.allowed, true);
              else
                assert.equal(
                  state.allowed,
                  false,
                  'Lost publication response must be reconciled before claiming quarantine',
                );
              if (stage === 'published') {
                const { pid } = JSON.parse(
                  await readFile(resolve(base, 'restore-session.json'), 'utf8'),
                );
                assert.equal(
                  (await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [pid]))
                    .rowCount,
                  0,
                );
              }
              if (stage !== 'unknown') {
                const target = new URL(adminBase);
                target.pathname = '/' + db;
                target.username = 'sift_runtime';
                target.password = '';
                const runtime = new Pool({ connectionString: target.href });
                try {
                  await assert.rejects(
                    () => runtime.query('SELECT 1'),
                    (e) => ['42501', '53300'].includes(e.code),
                  );
                } finally {
                  await runtime.end();
                }
              }
            });
        } finally {
          await admin.end();
        }
      },
    );
    const f = await fixture('combined', ['projects', 'context', 'work', 'planning', 'extensions']);
    const permissions = [
      'foundation:read',
      'projects:read',
      'context:read',
      'context:write',
      'work:read',
      'work:write',
      'extensions:read',
      'extensions:write',
    ];
    const a = await agent(f, 'worker_a', permissions),
      b = await agent(f, 'worker_b', permissions);
    let project, note, work;
    await t.test(
      'CLI creates project, note, planning task and linked work; idempotency is durable',
      async () => {
        project = await callCli(f, 'projects.create', {
          title: 'Synthetic headless project',
          instructions: 'Use the evidence ledger and preserve sources',
        });
        note = await callCli(f, 'notes.create', {
          title: 'Decision',
          body: 'Use local PostgreSQL transactions for durable coordination',
          projectId: project.id,
          source: 'fixture://decision/1',
        });
        const task = await callCli(f, 'tasks.create', {
          title: 'Prove handoff',
          projectId: project.id,
          acceptance: 'Agent B can continue from persisted evidence',
        });
        const payload = {
          title: 'Headless handoff',
          projectId: project.id,
          taskId: task.id,
          contextIds: [note.id],
          steps: [{ key: 'journey', title: 'Observe the handoff', required: true }],
        };
        work = await callCli(f, 'work.create', payload, 'create-handoff');
        assert.equal((await callCli(f, 'work.create', payload, 'create-handoff')).id, work.id);
        await reject(
          () =>
            invoke(f.owner, 'work.create', { ...payload, title: 'Different' }, 'create-handoff'),
          'idempotency_conflict',
        );
        assert.equal(work.links.length, 3);
        assert.equal(work.coverage.state, 'unverified');
      },
    );
    await t.test(
      'two independent principals race; stale, wrong-owner and expired claims are rejected',
      async () => {
        // Discard a successful claim response, then reconcile using the same
        // durable request identity and client-owned lease secret.
        const uncertain = await createWork(f.owner);
        const credential = await readCredentials(a.path);
        const lostKey = randomUUID();
        const lostInput = {
          id: uncertain.id,
          claimSecret: randomBytes(32).toString('hex'),
          leaseSeconds: 300,
        };
        const lost = await fetch(new URL('/v1/operations/work.claim', f.url), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential.token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': lostKey,
          },
          body: JSON.stringify(lostInput),
        });
        assert.equal(lost.status, 200);
        await lost.body.cancel();
        const reconciled = await a.client.call('work.claim', lostInput, lostKey);
        assert.equal(reconciled.epoch, 1);
        assert.equal((await invoke(f.owner, 'work.get', { id: uncertain.id })).epoch, 1);
        const w = await createWork(f.owner);
        const secretA = randomBytes(32).toString('hex'),
          secretB = randomBytes(32).toString('hex');
        const claims = await Promise.allSettled([
          a.client.call(
            'work.claim',
            { id: w.id, claimSecret: secretA, leaseSeconds: 1 },
            randomUUID(),
          ),
          b.client.call(
            'work.claim',
            { id: w.id, claimSecret: secretB, leaseSeconds: 1 },
            randomUUID(),
          ),
        ]);
        assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(
          claims.filter((r) => r.status === 'rejected' && r.reason.code === 'not_claimable').length,
          1,
        );
        const win = claims[0].status === 'fulfilled' ? a : b;
        const lose = win === a ? b : a;
        const secret = win === a ? secretA : secretB;
        const epoch = claims.find((r) => r.status === 'fulfilled').value.epoch;
        await reject(
          () =>
            lose.client.call('work.start', { id: w.id, claimSecret: secret, epoch }, randomUUID()),
          'stale_lease',
        );
        await new Promise((r) => setTimeout(r, 1100));
        const next = await invoke(lose.client, 'work.claim', { id: w.id });
        assert.equal(next.epoch, epoch + 1);
        await reject(
          () =>
            win.client.call('work.start', { id: w.id, claimSecret: secret, epoch }, randomUUID()),
          'stale_lease',
        );
      },
    );
    await t.test(
      'agent A records failed evidence and releases; agent B resumes through actual MCP',
      async () => {
        await callCli(f, 'work.claim', { id: work.id }, 'a-claim', a.path);
        await callCli(f, 'work.start', { id: work.id }, 'a-start', a.path);
        await callCli(
          f,
          'work.evidence',
          {
            id: work.id,
            planVersion: 1,
            stepId: work.plan.steps[0].id,
            attemptId: 'first',
            outcome: 'failed',
            output: 'First bounded check failed',
            provenance: 'fixture://attempt/a',
          },
          'a-evidence',
          a.path,
        );
        await callCli(f, 'work.release', { id: work.id }, 'a-release', a.path);
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [resolve(artifacts, 'packages/mcp/dist/index.js')],
          cwd: root,
          env: { PATH: process.env.PATH, SIFT_CONFIG: b.path, SIFT_TOOLS: 'work,context' },
          stderr: 'pipe',
        });
        const mcp = new Client({ name: 'acceptance-worker-b', version: '1.0.0' });
        await mcp.connect(transport);
        try {
          const tools = await mcp.listTools();
          assert.ok(tools.tools.some((t) => t.name === 'work_claim'));
          assert.ok(
            !tools.tools.some((t) => t.name === 'work_accept' || t.name === 'projects_create'),
          );
          const claimTool = tools.tools.find((t) => t.name === 'work_claim');
          assert.ok(!('claimSecret' in claimTool.inputSchema.properties));
          assert.deepEqual(claimTool.inputSchema.required, ['id', 'requestKey']);
          assert.equal(claimTool.inputSchema.properties.leaseSeconds.default, 300);
          assert.deepEqual(tools.tools.find((t) => t.name === 'work_get').inputSchema.required, [
            'id',
          ]);
          assert.deepEqual(
            tools.tools.find((t) => t.name === 'work_list').inputSchema.required,
            [],
          );

          const prev = parseTool(
            await mcp.callTool({ name: 'work_get', arguments: { id: work.id } }),
          );
          assert.equal(prev.coverage.state, 'failed');
          assert.equal(prev.evidence[0].outcome, 'failed');
          const context = parseTool(
            await mcp.callTool({ name: 'notes_get', arguments: { id: note.id } }),
          );
          assert.match(context.body, /PostgreSQL/);
          parseTool(
            await mcp.callTool({
              name: 'work_claim',
              arguments: { id: work.id, requestKey: 'b-claim' },
            }),
          );
          const started = parseTool(
            await mcp.callTool({
              name: 'work_start',
              arguments: { id: work.id, requestKey: 'b-start' },
            }),
          );
          assert.equal(started.status, 'running');
          const e = {
            id: work.id,
            planVersion: 1,
            stepId: work.plan.steps[0].id,
            attemptId: 'second',
            outcome: 'passed',
            output: 'Independent client observed persisted context and failed prior attempt',
            provenance: 'fixture://attempt/b',
            requestKey: 'b-evidence',
          };
          const passed = parseTool(await mcp.callTool({ name: 'work_evidence', arguments: e }));
          assert.equal(passed.coverage.state, 'commands_passed');
          parseTool(
            await mcp.callTool({
              name: 'work_review',
              arguments: {
                id: work.id,
                summary: 'Ready for operator review',
                requestKey: 'b-review',
              },
            }),
          );
          assert.equal(
            (
              await mcp.callTool({
                name: 'work_accept',
                arguments: { id: work.id, summary: 'Self approval', requestKey: 'bad-accept' },
              })
            ).isError,
            true,
          );
        } finally {
          await mcp.close();
        }
        await reject(
          () =>
            invoke(b.client, 'work.accept', { id: work.id, summary: 'Direct HTTP bypass attempt' }),
          'forbidden',
        );
        const accepted = await callCli(f, 'work.accept', {
          id: work.id,
          summary: 'Reviewed the stored evidence',
        });
        assert.equal(accepted.status, 'done');
        assert.equal(accepted.accepted_by, f.identity.principalId);
        assert.equal(accepted.accepted_plan_version, 1);
        assert.equal(accepted.coverage.state, 'commands_passed');
      },
    );
    await t.test(
      'negative evidence controls and version changes never produce vacuous success',
      async () => {
        const w = await createWork(f.owner);
        await invoke(a.client, 'work.claim', { id: w.id });
        const e = {
          id: w.id,
          planVersion: 1,
          stepId: w.plan.steps[0].id,
          attemptId: 'same',
          outcome: 'failed',
          output: 'Negative control',
          provenance: 'fixture://negative',
        };
        await reject(
          () => invoke(a.client, 'work.evidence', { ...e, stepId: randomUUID() }),
          'unknown_step',
        );
        await invoke(a.client, 'work.evidence', e);
        await reject(
          () => invoke(a.client, 'work.evidence', { ...e, outcome: 'passed' }),
          'attempt_conflict',
        );
        await reject(
          () =>
            invoke(f.owner, 'work.plan.revise', {
              id: w.id,
              steps: [{ key: 'new', title: 'New', required: true }],
              reason: 'Changed contract',
            }),
          'active_work',
        );
        await invoke(a.client, 'work.review', { id: w.id, summary: 'Failing check' });
        await reject(
          () => invoke(f.owner, 'work.accept', { id: w.id, summary: 'Try to bypass failure' }),
          'evidence_incomplete',
        );
        const revised = await invoke(f.owner, 'work.plan.revise', {
          id: w.id,
          steps: [{ key: 'new', title: 'New check', required: true }],
          reason: 'Explicit repair',
        });
        assert.equal(revised.coverage.state, 'unverified');
        const history = await invoke(f.owner, 'work.get', { id: w.id });
        assert.equal(history.plans.length, 2);
        assert.equal(history.evidence[0].outcome, 'failed');
        const dep = await createWork(f.owner, {
          dependencies: [{ id: w.id, gate: 'commands_passed' }],
        });
        await reject(() => invoke(a.client, 'work.claim', { id: dep.id }), 'not_claimable');
      },
    );
    await t.test(
      'schema definitions work without code changes; invalid records, references and breaking changes fail',
      async () => {
        const schema = {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1 },
            year: { type: 'integer', minimum: 1900 },
          },
          required: ['title'],
          additionalProperties: false,
        };
        await callCli(f, 'extensions.define', { type: 'research.paper', version: 1, schema });
        const paper = await callCli(f, 'objects.create', {
          type: 'research.paper',
          version: 1,
          data: { title: 'Synthetic paper', year: 2026 },
        });
        await reject(
          () =>
            invoke(a.client, 'objects.create', {
              type: 'research.paper',
              version: 1,
              data: { title: 42 },
            }),
          'invalid_record',
        );
        await reject(
          () =>
            invoke(f.owner, 'extensions.define', {
              type: 'research.unsafe',
              version: 1,
              schema: { $ref: 'https://example.invalid/schema' },
            }),
          'schema_keyword',
        );
        await reject(
          () =>
            invoke(f.owner, 'extensions.define', {
              type: 'research.paper',
              version: 2,
              schema: { ...schema, required: ['title', 'year'] },
            }),
          'breaking_schema',
        );
        await invoke(f.owner, 'extensions.define', {
          type: 'research.paper',
          version: 2,
          schema: { ...schema, properties: { ...schema.properties, url: { type: 'string' } } },
        });
        await invoke(f.owner, 'relations.define', {
          type: 'research.supports',
          sourceType: 'research.paper',
          targetType: 'projects.project',
        });
        await callCli(f, 'relations.create', {
          type: 'research.supports',
          source: { id: paper.id, type: 'research.paper' },
          target: { id: project.id, type: 'projects.project' },
        });
        assert.equal((await invoke(f.owner, 'relations.list', { id: paper.id })).length, 1);
        await reject(
          () =>
            invoke(f.owner, 'relations.create', {
              type: 'research.supports',
              source: { id: paper.id, type: 'research.paper' },
              target: { id: randomUUID(), type: 'projects.project' },
            }),
          'not_found',
        );
      },
    );
    await t.test(
      'scope, restricted SQL role, immutable history and credential revocation enforce boundaries',
      async () => {
        const other = await agent(f, 'other_owner', permissions, { ownerId: randomUUID() });
        const scoped = await agent(f, 'other_scope', permissions, { scopeId: randomUUID() });
        for (const g of [other, scoped]) {
          await reject(() => invoke(g.client, 'notes.get', { id: note.id }), 'not_found');
          assert.deepEqual(await invoke(g.client, 'work.list', {}), []);
          await reject(() => createWork(g.client, { projectId: project.id }), 'not_found');
        }
        const pool = new Pool({ connectionString: f.runtimeUrl });
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM work.items')).rows[0].n, 0);
        const role = (
          await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
        ).rows[0];
        assert.equal(role.rolsuper, false);
        assert.equal(role.rolbypassrls, false);
        await pool.query(
          "SELECT set_config('app.owner_id',$1,false),set_config('app.scope_id','',false)",
          [f.identity.ownerId],
        );
        await assert.rejects(
          () => pool.query("UPDATE work.evidence SET outcome='passed'"),
          (e) => e.code === '23514',
        );
        await pool.end();
        const privateStat = await stat(a.path);
        assert.equal(privateStat.mode & 0o077, 0);
        const meta = await readCredentials(other.path);
        await cli(['revoke', '--id', meta.principalId], f.adminUrl);
        await reject(() => invoke(other.client, 'work.list', {}), 'unauthorized');
      },
    );
    await t.test(
      'module changes refuse dependencies and hidden direct calls; packet omissions are explicit',
      async () => {
        await reject(
          () => invoke(f.owner, 'modules.set', { module: 'projects', enabled: false }),
          'module_dependents',
        );
        await reject(
          () => invoke(f.owner, 'modules.set', { module: 'context', enabled: false }),
          'module_references',
        );
        const packet = await invoke(f.owner, 'context.packet', { noteIds: [note.id], maxChars: 1 });
        assert.equal(packet.manifest.items.length, 0);
        assert.equal(packet.manifest.omissions[0].reason, 'character_budget');
        assert.equal(packet.manifest.omissions[0].omissionType, 'budget_exceeded');
        assert.match(packet.manifest.scopedCandidateDigest, /^[a-f0-9]{64}$/);
        const packet2 = await invoke(f.owner, 'context.packet', {
          noteIds: [note.id],
          maxChars: 10000,
        });
        assert.equal(packet2.manifest.items[0].revision, 1);
        assert.equal(packet2.manifest.scopedCandidateDigest, packet.manifest.scopedCandidateDigest);
        await invoke(f.owner, 'notes.update', {
          id: note.id,
          revision: 1,
          body: 'Updated local record',
        });
        const stored = await invoke(f.owner, 'context.packet.get', { id: packet2.id });
        assert.equal(stored.manifest.items[0].revision, 1);
        assert.equal(stored.digest, packet2.digest);
        assert.equal(stored.sources[0].status, 'changed');
        const separate = await fixture('toggle', ['work']);
        await invoke(separate.owner, 'modules.set', { module: 'work', enabled: false });
        await reject(() => createWork(separate.owner), 'module_unavailable');
        assert.ok(!(await separate.owner.catalog()).some((t) => t.module === 'work'));
        await invoke(separate.owner, 'modules.set', { module: 'work', enabled: true });
        await createWork(separate.owner);
        await cli(['install', '--modules', 'extensions'], separate.adminUrl);
        await invoke(separate.owner, 'extensions.define', {
          type: 'research.paper',
          version: 1,
          schema: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
            additionalProperties: false,
          },
        });
        await invoke(separate.owner, 'relations.define', {
          type: 'research.supports',
          sourceType: 'research.paper',
          targetType: 'work.item',
        });
        await reject(
          () => invoke(separate.owner, 'modules.set', { module: 'work', enabled: false }),
          'module_references',
        );
        await stop(separate);
      },
    );
    await t.test(
      'CRUD revisions, deletion, restore and custom relationship editing work through CLI',
      async () => {
        const p = await callCli(f, 'projects.create', { title: 'CRUD project' });
        const pu = await callCli(f, 'projects.update', {
          id: p.id,
          revision: 1,
          title: 'Revised project',
          instructions: 'Keep history',
        });
        assert.equal(pu.revision, 2);
        await reject(
          () =>
            invoke(f.owner, 'projects.update', {
              id: p.id,
              revision: 1,
              title: 'Stale overwrite',
              instructions: '',
            }),
          'revision_conflict',
        );
        const n = await callCli(f, 'notes.create', {
          title: 'Disposable note',
          body: 'Searchable tombstone content',
          projectId: p.id,
        });
        const nu = await callCli(f, 'notes.update', {
          id: n.id,
          revision: 1,
          title: 'Updated note',
          source: 'fixture://updated',
          body: 'Searchable replacement',
        });
        assert.equal(nu.title, 'Updated note');
        assert.equal((await callCli(f, 'notes.history', { id: n.id })).length, 2);
        const task = await callCli(f, 'tasks.create', { title: 'Human plan', projectId: p.id });
        const tu = await callCli(f, 'tasks.update', {
          id: task.id,
          revision: 1,
          title: 'Human plan completed',
          acceptance: 'Observed locally',
          status: 'done',
        });
        assert.equal(tu.status, 'done');
        assert.equal((await callCli(f, 'tasks.list', { projectId: p.id }))[0].id, task.id);
        await reject(
          () =>
            invoke(f.owner, 'projects.delete', {
              id: p.id,
              revision: 2,
              reason: 'Test references',
            }),
          'referenced_record',
        );
        for (const [type, id, revision] of [
          ['notes', n.id, 2],
          ['tasks', task.id, 2],
        ]) {
          await callCli(f, `${type}.delete`, { id, revision, reason: 'Synthetic cleanup' });
          await reject(() => invoke(f.owner, `${type}.get`, { id }), 'not_found');
          assert.ok((await callCli(f, `${type}.get`, { id, includeDeleted: true })).deleted_at);
          assert.ok(!(await callCli(f, `${type}.list`, {})).some((r) => r.id === id));
        }
        assert.ok(
          !(await callCli(f, 'notes.search', { query: 'replacement' })).some((r) => r.id === n.id),
        );
        await callCli(f, 'projects.delete', {
          id: p.id,
          revision: 2,
          reason: 'No active dependents',
        });
        await reject(
          () =>
            invoke(f.owner, 'tasks.restore', {
              id: task.id,
              revision: 3,
              reason: 'Missing parent',
            }),
          'not_found',
        );
        await callCli(f, 'projects.restore', { id: p.id, revision: 3, reason: 'Recover project' });
        await callCli(f, 'tasks.restore', { id: task.id, revision: 3, reason: 'Recover task' });
        await callCli(f, 'notes.restore', { id: n.id, revision: 3, reason: 'Recover note' });
        assert.equal((await callCli(f, 'notes.history', { id: n.id })).length, 4);
        const obj = await callCli(f, 'objects.create', {
          type: 'research.paper',
          version: 1,
          data: { title: 'Editable object' },
        });
        const ou = await callCli(f, 'objects.update', {
          id: obj.id,
          revision: 1,
          version: 2,
          data: { title: 'Updated object', url: 'fixture://paper' },
        });
        assert.equal(ou.revision, 2);
        await reject(
          () =>
            invoke(f.owner, 'objects.update', {
              id: obj.id,
              revision: 2,
              version: 2,
              data: { title: 12 },
            }),
          'invalid_record',
        );
        const rel = await callCli(f, 'relations.create', {
          type: 'research.supports',
          source: { id: obj.id, type: 'research.paper' },
          target: { id: p.id, type: 'projects.project' },
        });
        await callCli(f, 'relations.update', {
          id: rel.id,
          type: 'research.supports',
          source: { id: obj.id, type: 'research.paper' },
          target: { id: project.id, type: 'projects.project' },
        });
        assert.equal((await callCli(f, 'relations.get', { id: rel.id })).target_id, project.id);
        await callCli(f, 'relations.delete', { id: rel.id });
        await reject(() => invoke(f.owner, 'relations.get', { id: rel.id }), 'not_found');
        await callCli(f, 'objects.delete', {
          id: obj.id,
          revision: 2,
          reason: 'Hide custom record',
        });
        await reject(() => invoke(f.owner, 'objects.get', { id: obj.id }), 'not_found');
        await callCli(f, 'objects.restore', {
          id: obj.id,
          revision: 3,
          reason: 'Recover custom record',
        });
        assert.equal((await callCli(f, 'objects.get', { id: obj.id })).revision, 4);
        const other = await agent(
          f,
          'crud_scope',
          ['projects:write', 'planning:write', 'context:write', 'extensions:write'],
          { scopeId: randomUUID() },
        );
        await reject(
          () =>
            invoke(other.client, 'projects.update', {
              id: p.id,
              revision: 4,
              title: 'Cross scope',
              instructions: '',
            }),
          'not_found',
        );
        await reject(
          () =>
            invoke(a.client, 'notes.delete', { id: n.id, revision: 4, reason: 'Worker delete' }),
          'forbidden',
        );
      },
    );
    await t.test(
      'work editing, cycle controls, blocked and failed retries, artifacts and terminal protection',
      async () => {
        let w = await createWork(f.owner),
          predecessor = await createWork(f.owner);
        w = await callCli(f, 'work.update', {
          id: w.id,
          revision: w.revision,
          title: 'Edited executable work',
          description: 'Bounded retry',
          reason: 'Clarify intent',
        });
        w = await callCli(f, 'work.dependencies.set', {
          id: w.id,
          revision: w.revision,
          dependencies: [{ id: predecessor.id }],
          reason: 'Require predecessor',
        });
        await reject(
          () =>
            invoke(f.owner, 'work.dependencies.set', {
              id: predecessor.id,
              revision: 1,
              dependencies: [{ id: w.id }],
              reason: 'Cycle probe',
            }),
          'dependency_cycle',
        );
        await reject(() => invoke(a.client, 'work.claim', { id: w.id }), 'not_claimable');
        w = await callCli(f, 'work.dependencies.set', {
          id: w.id,
          revision: w.revision,
          dependencies: [],
          reason: 'Independent task',
        });
        const editedPlan = w.plan_version;
        await callCli(f, 'work.claim', { id: w.id }, 'lifecycle-claim-1', a.path);
        await callCli(f, 'work.start', { id: w.id }, 'lifecycle-start-1', a.path);
        await callCli(
          f,
          'work.heartbeat',
          { id: w.id, leaseSeconds: 30 },
          'lifecycle-heartbeat',
          a.path,
        );
        w = await callCli(
          f,
          'work.block',
          { id: w.id, reason: 'Missing input' },
          'lifecycle-block',
          a.path,
        );
        assert.equal(w.status, 'blocked');
        assert.equal(w.claimable, false);
        await reject(() => invoke(a.client, 'work.start', { id: w.id }), 'stale_lease');
        w = await callCli(f, 'work.requeue', { id: w.id, reason: 'Input supplied' });
        assert.equal(w.plan_version, editedPlan + 1);
        await callCli(f, 'work.claim', { id: w.id }, 'lifecycle-claim-2', a.path);
        w = await callCli(
          f,
          'work.fail',
          { id: w.id, reason: 'Execution failed' },
          'lifecycle-fail',
          a.path,
        );
        assert.equal(w.status, 'failed');
        w = await callCli(f, 'work.requeue', { id: w.id, reason: 'Try corrected approach' });
        assert.equal(w.plan_version, editedPlan + 2);
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [resolve(artifacts, 'packages/mcp/dist/index.js')],
          cwd: root,
          env: { PATH: process.env.PATH, SIFT_CONFIG: b.path, SIFT_TOOLS: 'work' },
          stderr: 'pipe',
        });
        let createdArtifactId;
        const mcp = new Client({ name: 'lifecycle-worker', version: '1.0.0' });
        await mcp.connect(transport);
        try {
          const tools = (await mcp.listTools()).tools;
          assert.ok(tools.some((t) => t.name === 'work_fail'));
          assert.ok(!tools.some((t) => t.name === 'work_requeue'));
          for (const [name, args] of [
            ['work_claim', { id: w.id }],
            ['work_start', { id: w.id }],
            [
              'work_artifacts_add',
              {
                id: w.id,
                name: 'Result',
                mediaType: 'text/plain',
                content: 'Synthetic stored output',
              },
            ],
            [
              'work_evidence',
              {
                id: w.id,
                planVersion: w.plan_version,
                stepId: w.plan.steps[0].id,
                attemptId: 'cycle3',
                outcome: 'passed',
                output: 'Observed stored artifact',
                provenance: 'fixture://artifact',
              },
            ],
            ['work_review', { id: w.id, summary: 'Ready' }],
          ]) {
            const requestKey = randomUUID();
            const result = parseTool(
              await mcp.callTool({ name, arguments: { ...args, requestKey } }),
            );
            if (name === 'work_artifacts_add') {
              createdArtifactId = result.artifactId;
              assert.match(createdArtifactId, /^[0-9a-f-]{36}$/);
              const replay = parseTool(
                await mcp.callTool({ name, arguments: { ...args, requestKey } }),
              );
              assert.deepEqual(replay, result);
              const direct = parseTool(
                await mcp.callTool({
                  name: 'work_artifacts_get',
                  arguments: { id: w.id, artifactId: createdArtifactId },
                }),
              );
              assert.equal(direct.content, args.content);
            }
          }
        } finally {
          await mcp.close();
        }
        const artifactsList = await callCli(f, 'work.artifacts.list', { id: w.id });
        assert.equal(artifactsList.length, 1);
        assert.equal(artifactsList[0].id, createdArtifactId);
        const artifact = await callCli(f, 'work.artifacts.get', {
          id: w.id,
          artifactId: artifactsList[0].id,
        });
        assert.equal(artifact.content, 'Synthetic stored output');
        assert.equal(artifact.digest, createHash('sha256').update(artifact.content).digest('hex'));
        // A rejected review starts fresh verification, preserving previous evidence/artifacts.
        w = await callCli(f, 'work.requeue', {
          id: w.id,
          reason: 'Operator requests another attempt',
        });
        assert.equal(w.coverage.state, 'unverified');
        assert.equal(w.plan_version, editedPlan + 3);
        await callCli(f, 'work.claim', { id: w.id }, 'lifecycle-final-claim', a.path);
        await callCli(
          f,
          'work.evidence',
          {
            id: w.id,
            planVersion: w.plan_version,
            stepId: w.plan.steps[0].id,
            attemptId: 'final',
            outcome: 'passed',
            output: 'Retested',
            provenance: 'fixture://retry',
          },
          'lifecycle-final-evidence',
          a.path,
        );
        await callCli(
          f,
          'work.review',
          { id: w.id, summary: 'Retested' },
          'lifecycle-final-review',
          a.path,
        );
        w = await callCli(f, 'work.accept', { id: w.id, summary: 'Accepted after retry' });
        for (const [name, args] of [
          ['work.requeue', { id: w.id, reason: 'Reopen accepted' }],
          [
            'work.plan.revise',
            {
              id: w.id,
              steps: [{ key: 'bad', title: 'Change accepted plan' }],
              reason: 'Terminal probe',
            },
          ],
        ])
          await reject(
            () => invoke(f.owner, name, args),
            name.endsWith('requeue') ? 'invalid_transition' : 'terminal',
          );
        const deleted = await callCli(f, 'work.delete', {
          id: w.id,
          revision: w.revision,
          reason: 'Archive completed work',
        });
        await reject(() => invoke(f.owner, 'work.get', { id: w.id }), 'not_found');
        assert.equal(
          (await callCli(f, 'work.get', { id: w.id, includeDeleted: true })).evidence.length,
          2,
        );
        await callCli(f, 'work.restore', {
          id: w.id,
          revision: deleted.revision,
          reason: 'Restore inspection',
        });
        assert.equal((await callCli(f, 'work.get', { id: w.id })).status, 'done');
      },
    );
    await t.test(
      'projects.bind and projects.resolve enforce normalization, longest-prefix, remote fallback, soft-delete, and RLS',
      async () => {
        const mono = await callCli(f, 'projects.create', {
          title: 'Bound monorepo project',
          instructions: 'Top-level repo binding',
        });
        const nested = await callCli(f, 'projects.create', {
          title: 'Bound nested app project',
          instructions: 'Nested package binding',
        });
        const boundMono = await callCli(f, 'projects.bind', {
          projectId: mono.id,
          rootPath: '/repos/acme/mono///',
          gitRemoteUrl: 'https://github.com/Acme/Mono.git',
          defaultBranch: 'main',
        });
        assert.equal(boundMono.projectId, mono.id);
        assert.equal(boundMono.rootPath, '/repos/acme/mono');
        assert.equal(boundMono.gitRemoteUrl, 'github.com/acme/mono');
        assert.equal(boundMono.defaultBranch, 'main');

        // Upsert on same rootPath updates metadata cleanly in place.
        const reboundMono = await callCli(f, 'projects.bind', {
          projectId: mono.id,
          rootPath: '/repos/acme/mono/',
          gitRemoteUrl: 'git@github.com:Acme/Mono.git',
          defaultBranch: 'trunk',
        });
        assert.equal(reboundMono.id, boundMono.id);
        assert.equal(reboundMono.gitRemoteUrl, 'github.com/acme/mono');
        assert.equal(reboundMono.defaultBranch, 'trunk');

        await callCli(f, 'projects.bind', {
          projectId: nested.id,
          rootPath: '/repos/acme/mono/apps/web',
          gitRemoteUrl: 'https://github.com/Acme/Mono.git',
          defaultBranch: 'main',
        });

        // Longest-prefix matches nested binding; sibling matches parent; prefix-collision does not match.
        const resolvedNested = await invoke(a.client, 'projects.resolve', {
          checkoutPath: '/repos/acme/mono/apps/web/src/app.ts',
        });
        assert.equal(resolvedNested.matched, true);
        assert.equal(resolvedNested.matchKind, 'root_path');
        assert.equal(resolvedNested.project.id, nested.id);

        const resolvedParent = await invoke(a.client, 'projects.resolve', {
          checkoutPath: '/repos/acme/mono/packages/core',
        });
        assert.equal(resolvedParent.matched, true);
        assert.equal(resolvedParent.matchKind, 'root_path');
        assert.equal(resolvedParent.project.id, mono.id);

        const nonMatchingSibling = await invoke(a.client, 'projects.resolve', {
          checkoutPath: '/repos/acme/mono-fork',
        });
        assert.deepEqual(nonMatchingSibling, {
          matched: false,
          matchKind: null,
          project: null,
          binding: null,
        });

        // Linked worktree outside bound root resolves via normalized gitRemoteUrl fallback.
        const resolvedWorktree = await invoke(a.client, 'projects.resolve', {
          checkoutPath: '/tmp/t3-worktrees/mono-feat-1',
          gitRemoteUrl: 'ssh://git@github.com:22/ACME/MONO.git',
        });
        assert.equal(resolvedWorktree.matched, true);
        assert.equal(resolvedWorktree.matchKind, 'git_remote');
        assert.ok([mono.id, nested.id].includes(resolvedWorktree.project.id));

        // Soft-deleted project is excluded from resolve and cannot be bound until restored.
        await callCli(f, 'projects.delete', {
          id: nested.id,
          revision: 1,
          reason: 'Verify deleted project excluded from resolve',
        });
        const afterDelete = await invoke(a.client, 'projects.resolve', {
          checkoutPath: '/repos/acme/mono/apps/web/src/app.ts',
        });
        assert.equal(afterDelete.matched, true);
        assert.equal(afterDelete.project.id, mono.id);
        await reject(
          () =>
            invoke(f.owner, 'projects.bind', {
              projectId: nested.id,
              rootPath: '/repos/acme/deleted',
            }),
          'not_found',
        );
        await callCli(f, 'projects.restore', {
          id: nested.id,
          revision: 2,
          reason: 'Restore bound project',
        });
        const afterRestore = await invoke(a.client, 'projects.resolve', {
          checkoutPath: '/repos/acme/mono/apps/web/src/app.ts',
        });
        assert.equal(afterRestore.matched, true);
        assert.equal(afterRestore.project.id, nested.id);

        // RLS isolates bindings across scopes.
        const otherScope = await agent(f, 'bind_other_scope', ['projects:read', 'projects:write'], {
          scopeId: randomUUID(),
        });
        const crossScope = await invoke(otherScope.client, 'projects.resolve', {
          checkoutPath: '/repos/acme/mono',
          gitRemoteUrl: 'https://github.com/acme/mono.git',
        });
        assert.equal(crossScope.matched, false);
        await reject(
          () =>
            invoke(otherScope.client, 'projects.bind', {
              projectId: mono.id,
              rootPath: '/repos/acme/mono',
            }),
          'not_found',
        );
      },
    );
    await t.test(
      'context.search indexes all domains via triggers with prefix fallback, RLS/delete/module isolation, and typed packet omissions',
      async () => {
        const searchProject = await callCli(f, 'projects.create', {
          title: 'Zephyrlattice search project',
          instructions: 'Cross-domain full text indexing benchmark',
        });
        const unrelatedProject = await callCli(f, 'projects.create', {
          title: 'Zephyrlattice unrelated project',
          instructions: 'Must be filtered out when projectId is set',
        });
        const searchNote = await callCli(f, 'notes.create', {
          title: 'Zephyrlattice architecture note',
          body: 'Trigger-synced search vector without embeddings',
          projectId: searchProject.id,
          source: 'fixture://search/note',
        });
        const searchNote2 = await callCli(f, 'notes.create', {
          title: 'Companion packet note',
          body: 'Secondary scoped candidate for digest checks',
          projectId: searchProject.id,
        });
        const searchTask = await callCli(f, 'tasks.create', {
          title: 'Zephyrlattice verification task',
          projectId: searchProject.id,
          acceptance: 'Confirm cross-domain ranking and domain filters',
        });
        const searchObj = await callCli(f, 'objects.create', {
          type: 'research.paper',
          version: 2,
          data: {
            title: 'Zephyrlattice whitepaper',
            year: 2026,
            url: 'fixture://zephyrlattice-paper',
          },
        });

        // Cross-domain search finds all 4 domains with FTS matchMode.
        const allHits = await invoke(f.owner, 'context.search', { query: 'zephyrlattice' });
        assert.equal(allHits.matchMode, 'fts');
        assert.equal(allHits.query, 'zephyrlattice');
        const hitById = new Map(allHits.items.map((item) => [item.entityId, item]));
        assert.equal(hitById.get(searchProject.id)?.domain, 'project');
        assert.equal(hitById.get(searchProject.id)?.entityType, 'projects.project');
        assert.equal(hitById.get(searchProject.id)?.projectId, searchProject.id);
        assert.equal(hitById.get(searchNote.id)?.domain, 'note');
        assert.equal(hitById.get(searchNote.id)?.entityType, 'context.note');
        assert.equal(hitById.get(searchNote.id)?.projectId, searchProject.id);
        assert.equal(hitById.get(searchTask.id)?.domain, 'task');
        assert.equal(hitById.get(searchTask.id)?.entityType, 'planning.task');
        assert.equal(hitById.get(searchTask.id)?.projectId, searchProject.id);
        assert.equal(hitById.get(searchObj.id)?.domain, 'object');
        assert.equal(hitById.get(searchObj.id)?.entityType, 'research.paper');
        assert.ok(allHits.items.every((item) => typeof item.score === 'number' && item.score > 0));

        // Domain filter restricts results strictly to requested domains.
        const noteAndTask = await invoke(f.owner, 'context.search', {
          query: 'zephyrlattice',
          domains: ['note', 'task'],
        });
        assert.deepEqual(
          noteAndTask.items.map((i) => i.entityId).sort(),
          [searchNote.id, searchTask.id].sort(),
        );

        // Project filter excludes unrelated project records and unlinked objects.
        const projectOnly = await invoke(f.owner, 'context.search', {
          query: 'zephyrlattice',
          projectId: searchProject.id,
        });
        assert.deepEqual(
          projectOnly.items.map((i) => i.entityId).sort(),
          [searchProject.id, searchNote.id, searchTask.id].sort(),
        );
        assert.ok(!projectOnly.items.some((i) => i.entityId === unrelatedProject.id));

        // Prefix fallback engages on zero FTS hits and sanitizes hostile punctuation safely.
        const prefixHits = await invoke(f.owner, 'context.search', { query: 'zephyrlat' });
        assert.equal(prefixHits.matchMode, 'prefix_fallback');
        assert.ok(prefixHits.items.some((i) => i.entityId === searchNote.id));

        const hostileQuery = await invoke(f.owner, 'context.search', {
          query: "zephyrlat:!! & (|) 'arch--'",
        });
        assert.equal(hostileQuery.matchMode, 'prefix_fallback');
        assert.ok(hostileQuery.items.some((i) => i.entityId === searchNote.id));

        const punctuationOnly = await invoke(f.owner, 'context.search', { query: '!!! &&& :::' });
        assert.equal(punctuationOnly.matchMode, 'fts');
        assert.deepEqual(punctuationOnly.items, []);

        // Trigger updates context.index on record update.
        await callCli(f, 'notes.update', {
          id: searchNote.id,
          revision: 1,
          title: 'Quasarbeacon updated note',
          body: 'Replaced token after edit',
        });
        const afterEdit = await invoke(f.owner, 'context.search', { query: 'quasarbeacon' });
        assert.equal(afterEdit.matchMode, 'fts');
        assert.deepEqual(
          afterEdit.items.map((i) => i.entityId),
          [searchNote.id],
        );

        // Soft-delete hides records by default and surfaces them with includeDeleted: true.
        const deletedNote = await callCli(f, 'notes.delete', {
          id: searchNote.id,
          revision: 2,
          reason: 'Verify search soft-delete exclusion',
        });
        const hiddenSearch = await invoke(f.owner, 'context.search', { query: 'quasarbeacon' });
        assert.deepEqual(hiddenSearch.items, []);
        const includedSearch = await invoke(f.owner, 'context.search', {
          query: 'quasarbeacon',
          includeDeleted: true,
        });
        assert.equal(includedSearch.items.length, 1);
        assert.equal(includedSearch.items[0].entityId, searchNote.id);
        assert.ok(includedSearch.items[0].deletedAt);

        // Typed packet omissions: budget_exceeded, deleted, not_found, and deterministic scopedCandidateDigest.
        const missingId = randomUUID();
        const omitPacket = await invoke(f.owner, 'context.packet', {
          noteIds: [searchNote.id, missingId, searchNote2.id],
          maxChars: 1,
          omitUnavailable: true,
        });
        assert.equal(omitPacket.manifest.items.length, 0);
        assert.equal(omitPacket.manifest.omissions.length, 3);
        assert.deepEqual(
          omitPacket.manifest.omissions.map((o) => ({
            id: o.id,
            omissionType: o.omissionType,
            reason: o.reason,
          })),
          [
            { id: searchNote.id, omissionType: 'deleted', reason: 'deleted' },
            { id: missingId, omissionType: 'not_found', reason: 'not_found' },
            { id: searchNote2.id, omissionType: 'budget_exceeded', reason: 'character_budget' },
          ],
        );
        await reject(
          () => invoke(f.owner, 'context.packet', { noteIds: [searchNote.id], maxChars: 1000 }),
          'not_found',
        );

        // Restore note and verify order-independent pre-truncation scopedCandidateDigest.
        await callCli(f, 'notes.restore', {
          id: searchNote.id,
          revision: deletedNote.revision,
          reason: 'Restore for packet digest check',
        });
        const restoredSearch = await invoke(f.owner, 'context.search', { query: 'quasarbeacon' });
        assert.equal(restoredSearch.items.length, 1);

        const fullPacket = await invoke(f.owner, 'context.packet', {
          noteIds: [searchNote.id, searchNote2.id],
          maxChars: 10000,
        });
        const truncatedReversedPacket = await invoke(f.owner, 'context.packet', {
          noteIds: [searchNote2.id, searchNote.id],
          maxChars: 1,
        });
        assert.equal(fullPacket.manifest.items.length, 2);
        assert.equal(truncatedReversedPacket.manifest.items.length, 0);
        assert.ok(
          truncatedReversedPacket.manifest.omissions.every(
            (o) => o.omissionType === 'budget_exceeded' && o.reason === 'character_budget',
          ),
        );
        assert.equal(
          truncatedReversedPacket.manifest.scopedCandidateDigest,
          fullPacket.manifest.scopedCandidateDigest,
        );
        await callCli(f, 'notes.update', {
          id: searchNote2.id,
          revision: 1,
          body: 'Updated companion note changes candidate revision digest',
        });
        const postUpdatePacket = await invoke(f.owner, 'context.packet', {
          noteIds: [searchNote.id, searchNote2.id],
          maxChars: 10000,
        });
        assert.notEqual(
          postUpdatePacket.manifest.scopedCandidateDigest,
          fullPacket.manifest.scopedCandidateDigest,
        );

        // RLS isolates context.index across scopes, and agent RBAC restricts cross-module domains.
        const searchOtherScope = await agent(
          f,
          'search_other_scope',
          ['context:read', 'projects:read', 'planning:read', 'extensions:read'],
          { scopeId: randomUUID() },
        );
        const crossScopeSearch = await invoke(searchOtherScope.client, 'context.search', {
          query: 'zephyrlattice',
        });
        assert.deepEqual(crossScopeSearch.items, []);

        // Worker a lacks planning:read, so task hits are excluded while project/object hits remain visible.
        const workerSearch = await invoke(a.client, 'context.search', { query: 'zephyrlattice' });
        assert.ok(workerSearch.items.some((i) => i.entityId === searchProject.id));
        assert.ok(workerSearch.items.some((i) => i.entityId === searchObj.id));
        assert.ok(!workerSearch.items.some((i) => i.entityId === searchTask.id));

        // Late install of optional module attaches FTS triggers and disabled modules never leak into context.search.
        const late = await fixture('late_fts', ['context']);
        try {
          const lateNote = await callCli(late, 'notes.create', {
            title: 'Nebulavector context-only note',
            body: 'Created before extensions module was installed',
          });
          await cli(['install', '--modules', 'extensions'], late.adminUrl);
          await invoke(late.owner, 'extensions.define', {
            type: 'research.memo',
            version: 1,
            schema: {
              type: 'object',
              properties: { title: { type: 'string' }, summary: { type: 'string' } },
              required: ['title'],
              additionalProperties: false,
            },
          });
          const lateObj = await invoke(late.owner, 'objects.create', {
            type: 'research.memo',
            version: 1,
            data: {
              title: 'Nebulavector extension memo',
              summary: 'Indexed via post-install sync',
            },
          });
          const bothDomains = await invoke(late.owner, 'context.search', {
            query: 'nebulavector',
          });
          assert.deepEqual(
            bothDomains.items.map((i) => i.entityId).sort(),
            [lateNote.id, lateObj.id].sort(),
          );
          await invoke(late.owner, 'modules.set', { module: 'extensions', enabled: false });
          const afterDisable = await invoke(late.owner, 'context.search', {
            query: 'nebulavector',
          });
          assert.deepEqual(
            afterDisable.items.map((i) => i.entityId),
            [lateNote.id],
          );
          await invoke(late.owner, 'modules.set', { module: 'extensions', enabled: true });
          const afterReenable = await invoke(late.owner, 'context.search', {
            query: 'nebulavector',
          });
          assert.deepEqual(
            afterReenable.items.map((i) => i.entityId).sort(),
            [lateNote.id, lateObj.id].sort(),
          );
        } finally {
          await stop(late);
        }
      },
    );
    await t.test(
      'native backup restores exact records, schemas and receipts; corruption and overwrite are refused',
      async () => {
        const active = await createWork(f.owner);
        await invoke(a.client, 'work.claim', { id: active.id });
        const before = await callCli(f, 'work.get', { id: work.id });
        const backup = resolve(base, 'combined-backup');
        const receipt = await cli(['backup', '--output', backup], f.adminUrl);
        assert.ok(receipt.rows > 0);
        assert.ok((await cli(['backup-verify', '--file', backup])).verified);
        assert.equal((await stat(resolve(backup, 'database.dump'))).mode & 0o077, 0);
        const tampered = resolve(base, 'tampered-backup');
        await cp(backup, tampered, { recursive: true });
        await appendFile(resolve(tampered, 'database.dump'), 'corrupt');
        await assert.rejects(
          () => cli(['backup-verify', '--file', tampered]),
          (e) => /checksum mismatch/.test(e.stderr),
        );
        const db = `sift_restore_${runId}`;
        await assert.rejects(() =>
          cli(['restore', '--file', tampered, '--database', db], adminBase),
        );
        const restored = await cli(['restore', '--file', backup, '--database', db], adminBase);
        assert.equal(restored.integrity, 'verified');
        assert.ok(restored.invalidatedLeases >= 1);
        const target = new URL(adminBase);
        target.pathname = '/' + db;
        const adminUrl = target.href;
        target.username = 'sift_runtime';
        target.password = '';
        const dir = resolve(base, 'restored');
        await mkdir(dir, { mode: 0o700 });
        const ownerPath = resolve(dir, 'owner.json');
        await cp(f.ownerPath, ownerPath);
        const recovered = {
          db,
          dir,
          adminUrl,
          runtimeUrl: target.href,
          ownerPath,
          credentials: [ownerPath],
          identity: f.identity,
        };
        fixtures.push(recovered);
        await start(recovered);
        const after = await callCli(recovered, 'work.get', { id: work.id });
        assert.deepEqual(after, before);
        const originalCreate = {
          title: 'Headless handoff',
          projectId: project.id,
          taskId: work.links.find((l) => l.relation === 'implements').target_id,
          contextIds: [note.id],
          steps: [{ key: 'journey', title: 'Observe the handoff', required: true }],
        };
        assert.equal(
          (await callCli(recovered, 'work.create', originalCreate, 'create-handoff')).id,
          work.id,
        );
        const replayActive = await callCli(recovered, 'work.get', { id: active.id });
        assert.equal(replayActive.status, 'queued');
        assert.equal(replayActive.epoch, 2);
        assert.ok(replayActive.history.some((e) => e.event === 'restore.lease_invalidated'));
        assert.ok(
          (await callCli(recovered, 'schema.inspect', {})).extensions.some(
            (x) => x.type === 'research.paper' && x.version === 2,
          ),
        );
        assert.ok(
          (await callCli(recovered, 'objects.list', { type: 'research.paper' })).length >= 2,
        );
        assert.equal((await callCli(recovered, 'notes.get', { id: note.id })).revision, 2);
        const restoredBinding = await callCli(recovered, 'projects.resolve', {
          checkoutPath: '/repos/acme/mono/apps/web/src/app.ts',
        });
        assert.equal(restoredBinding.matched, true);
        assert.equal(restoredBinding.matchKind, 'root_path');
        assert.equal(restoredBinding.binding.rootPath, '/repos/acme/mono/apps/web');
        await callCli(recovered, 'notes.create', {
          title: 'After recovery',
          body: 'Proves sequence and grants continue',
        });
        await assert.rejects(
          () => cli(['restore', '--file', backup, '--database', db], adminBase),
          (e) => /existing database/.test(e.stderr),
        );
        const pool = new Pool({ connectionString: recovered.runtimeUrl });
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM work.items')).rows[0].n, 0);
        await assert.rejects(
          () => pool.query('SELECT * FROM foundation.principals'),
          (e) => e.code === '42501',
        );
        await pool.end();
        await stop(recovered);
      },
    );
    await t.test(
      'context-only backup preserves disabled modules and rejects a mismatched data manifest',
      async () => {
        const source = fixtures.find((x) => x.db.startsWith('sift_context_'));
        await start(source);
        await callCli(source, 'modules.set', { module: 'context', enabled: false });
        await stop(source);
        const backup = resolve(base, 'context-backup');
        const receipt = await cli(['backup', '--output', backup], source.adminUrl);
        assert.deepEqual(receipt.modules, ['context', 'foundation']);
        const db = `sift_minrestore_${runId}`;
        await cli(['restore', '--file', backup, '--database', db], adminBase);
        const target = new URL(adminBase);
        target.pathname = '/' + db;
        const adminUrl = target.href;
        target.username = 'sift_runtime';
        target.password = '';
        const dir = resolve(base, 'minrestore');
        await mkdir(dir, { mode: 0o700 });
        const ownerPath = resolve(dir, 'owner.json');
        await cp(source.ownerPath, ownerPath);
        const recovered = {
          db,
          dir,
          adminUrl,
          runtimeUrl: target.href,
          ownerPath,
          credentials: [ownerPath],
          identity: source.identity,
        };
        fixtures.push(recovered);
        await start(recovered);
        assert.ok(!(await recovered.owner.catalog()).some((x) => x.module === 'context'));
        await reject(() => invoke(recovered.owner, 'notes.list', {}), 'module_unavailable');
        await callCli(recovered, 'modules.set', { module: 'context', enabled: true });
        assert.equal((await callCli(recovered, 'notes.list', {})).length, 1);
        const pool = new Pool({ connectionString: adminUrl });
        assert.equal(
          (await pool.query("SELECT to_regnamespace('work') AS name")).rows[0].name,
          null,
        );
        await pool.end();
        await stop(recovered);
        const bad = resolve(base, 'bad-manifest');
        await cp(backup, bad, { recursive: true });
        const manifestPath = resolve(bad, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.tables[0].sha256 = '0'.repeat(64);
        await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
        const failedDb = `sift_failedrestore_${runId}`;
        // Only this newly created test database may be cleaned up by the fixture owner.
        fixtures.push({ db: failedDb });
        await assert.rejects(
          () => cli(['restore', '--file', bad, '--database', failedDb], adminBase),
          (e) => /Recovery did not complete/.test(e.stderr),
        );
        const admin = new Pool({ connectionString: adminBase });
        assert.equal(
          (
            await admin.query(
              "SELECT has_database_privilege('sift_runtime',$1,'CONNECT') AS allowed",
              [failedDb],
            )
          ).rows[0].allowed,
          false,
        );
        await admin.end();
      },
    );
    await t.test('editing previously verified released work invalidates old evidence', async () => {
      let w = await createWork(f.owner);
      await invoke(a.client, 'work.claim', { id: w.id });
      await invoke(a.client, 'work.evidence', {
        id: w.id,
        planVersion: w.plan_version,
        stepId: w.plan.steps[0].id,
        attemptId: 'before-edit',
        outcome: 'passed',
        output: 'Old requirement passed',
        provenance: 'fixture://edit',
      });
      w = await invoke(a.client, 'work.release', { id: w.id });
      assert.equal(w.coverage.state, 'commands_passed');
      w = await callCli(f, 'work.update', {
        id: w.id,
        revision: w.revision,
        title: 'Changed requirement',
        description: 'Different intended outcome',
        reason: 'Explicit scope change',
      });
      assert.equal(w.coverage.state, 'unverified');
      assert.equal(w.plan_version, 2);
      await invoke(a.client, 'work.claim', { id: w.id });
      await invoke(a.client, 'work.review', { id: w.id, summary: 'No new evidence' });
      await reject(
        () => invoke(f.owner, 'work.accept', { id: w.id, summary: 'Try old evidence' }),
        'evidence_incomplete',
      );
    });
    await t.test(
      'work.fork and work.graph enforce revisions, project inheritance, frontier ordering, filtering, and fresh post-fork verification',
      async () => {
        const dagProject = await callCli(f, 'projects.create', {
          title: 'DAG acceptance project',
          instructions: 'Verify work.fork and work.graph on real PostgreSQL 17',
        });
        const otherProject = await callCli(f, 'projects.create', {
          title: 'Unrelated DAG project',
        });
        const unrelated = await createWork(f.owner, {
          title: 'Unrelated project root',
          projectId: otherProject.id,
        });
        const root = await createWork(f.owner, {
          title: 'DAG root integration',
          projectId: dagProject.id,
        });
        const sideRoot = await createWork(f.owner, {
          title: 'Independent DAG root',
          projectId: dagProject.id,
        });

        // Record passing pre-fork evidence on plan version 1, then block the parent before forking.
        await invoke(a.client, 'work.claim', { id: root.id });
        await invoke(a.client, 'work.start', { id: root.id });
        await invoke(a.client, 'work.evidence', {
          id: root.id,
          planVersion: 1,
          stepId: root.plan.steps[0].id,
          attemptId: 'pre-fork-pass',
          outcome: 'passed',
          output: 'Passed before forking into sub-branches',
          provenance: 'fixture://pre-fork',
        });
        const blockedRoot = await invoke(a.client, 'work.block', {
          id: root.id,
          reason: 'Needs parallel sub-branches',
        });
        assert.equal(blockedRoot.status, 'blocked');
        assert.equal(blockedRoot.plan_version, 1);
        assert.equal(blockedRoot.coverage.state, 'commands_passed');

        // Stale revision must be rejected with revision_conflict without mutating state.
        await reject(
          () =>
            invoke(a.client, 'work.fork', {
              id: root.id,
              revision: blockedRoot.revision - 1,
              reason: 'Stale revision probe',
              branches: [{ title: 'Should not exist' }],
            }),
          'revision_conflict',
        );

        // Fork the blocked parent into two branches; parent resets to queued (not claimable) with bumped plan_version & revision.
        const fork1 = await callCli(
          f,
          'work.fork',
          {
            id: root.id,
            revision: blockedRoot.revision,
            reason: 'Decompose root into two parallel branches',
            branches: [
              { title: 'Branch Alpha', description: 'Nested branch' },
              { title: 'Branch Beta', description: 'Direct branch' },
            ],
          },
          'fork-root-branches',
          a.path,
        );
        assert.equal(fork1.parent.status, 'queued');
        assert.equal(fork1.parent.claimable, false);
        assert.equal(fork1.parent.plan_version, 2);
        assert.equal(fork1.parent.revision, blockedRoot.revision + 1);
        assert.equal(fork1.parent.coverage.state, 'unverified');
        assert.equal(fork1.branches.length, 2);
        const [branchA, branchB] = fork1.branches;
        for (const branch of [branchA, branchB]) {
          assert.equal(branch.status, 'queued');
          assert.equal(branch.claimable, true);
          assert.ok(
            branch.links.some((l) => l.relation === 'belongs_to' && l.target_id === dagProject.id),
            'Forked branch must inherit parent belongs_to project link',
          );
        }

        // Reusing the pre-fork revision must also fail with revision_conflict.
        await reject(
          () =>
            invoke(a.client, 'work.fork', {
              id: root.id,
              revision: blockedRoot.revision,
              reason: 'Stale post-fork revision probe',
              branches: [{ title: 'Duplicate stale branch' }],
            }),
          'revision_conflict',
        );

        // Fork queued branchA into a leaf to create a 3-level DAG (leafA -> branchA -> root, branchB -> root).
        const fork2 = await invoke(a.client, 'work.fork', {
          id: branchA.id,
          revision: branchA.revision,
          reason: 'Split branchA into leaf work',
          branches: [{ title: 'Leaf Alpha', description: 'Deepest dependency' }],
        });
        assert.equal(fork2.parent.status, 'queued');
        assert.equal(fork2.parent.claimable, false);
        assert.equal(fork2.parent.plan_version, 2);
        assert.equal(fork2.parent.revision, branchA.revision + 1);
        const leafA = fork2.branches[0];
        assert.equal(leafA.claimable, true);
        assert.ok(
          leafA.links.some((l) => l.relation === 'belongs_to' && l.target_id === dagProject.id),
          'Nested forked leaf must inherit belongs_to project link',
        );

        // Verify projectId-scoped work.graph returns accurate nodes, edges, roots, waiting ratios, transitive unblocksCount, and next ordering.
        const projectGraph = await callCli(f, 'work.graph', { projectId: dagProject.id });
        assert.deepEqual(
          projectGraph.nodes.map((n) => n.id).sort(),
          [root.id, sideRoot.id, branchA.id, branchB.id, leafA.id].sort(),
        );
        assert.ok(!projectGraph.nodes.some((n) => n.id === unrelated.id));
        assert.deepEqual(projectGraph.roots.map((r) => r.id).sort(), [root.id, sideRoot.id].sort());
        assert.equal(projectGraph.edges.length, 3);
        assert.ok(projectGraph.edges.every((e) => e.satisfied === false));

        const byId = new Map(projectGraph.nodes.map((n) => [n.id, n]));
        assert.equal(byId.get(root.id).isRoot, true);
        assert.equal(byId.get(root.id).depth, 0);
        assert.equal(byId.get(root.id).uiState, 'waiting');
        assert.equal(byId.get(root.id).claimable, false);
        assert.deepEqual(byId.get(root.id).waiting, { satisfied: 0, total: 2 });
        assert.equal(byId.get(root.id).unblocksCount, 0);

        assert.equal(byId.get(branchA.id).depth, 1);
        assert.equal(byId.get(branchA.id).uiState, 'waiting');
        assert.deepEqual(byId.get(branchA.id).waiting, { satisfied: 0, total: 1 });
        assert.equal(byId.get(branchA.id).directUnblocksCount, 1);
        assert.equal(byId.get(branchA.id).unblocksCount, 1);

        assert.equal(byId.get(branchB.id).depth, 1);
        assert.equal(byId.get(branchB.id).uiState, 'ready');
        assert.deepEqual(byId.get(branchB.id).waiting, { satisfied: 0, total: 0 });
        assert.equal(byId.get(branchB.id).unblocksCount, 1);

        assert.equal(byId.get(leafA.id).depth, 2);
        assert.equal(byId.get(leafA.id).uiState, 'ready');
        assert.equal(byId.get(leafA.id).directUnblocksCount, 1);
        assert.equal(byId.get(leafA.id).unblocksCount, 2);

        assert.equal(byId.get(sideRoot.id).isRoot, true);
        assert.equal(byId.get(sideRoot.id).uiState, 'ready');
        assert.equal(byId.get(sideRoot.id).unblocksCount, 0);

        // Frontier ordering: higher transitive unblocksCount first (leafA: 2, branchB: 1, sideRoot: 0).
        assert.deepEqual(projectGraph.next, [leafA.id, branchB.id, sideRoot.id]);

        // Verify rootId filtering (both combined with projectId and standalone).
        const rootGraph = await invoke(a.client, 'work.graph', {
          projectId: dagProject.id,
          rootId: root.id,
        });
        assert.deepEqual(
          rootGraph.nodes.map((n) => n.id).sort(),
          [root.id, branchA.id, branchB.id, leafA.id].sort(),
        );
        assert.deepEqual(rootGraph.roots.map((r) => r.id).sort(), [root.id, sideRoot.id].sort());
        assert.deepEqual(rootGraph.next, [leafA.id, branchB.id]);

        const rootOnlyGraph = await invoke(a.client, 'work.graph', { rootId: root.id });
        assert.deepEqual(
          rootOnlyGraph.nodes.map((n) => n.id).sort(),
          [root.id, branchA.id, branchB.id, leafA.id].sort(),
        );
        assert.ok(rootOnlyGraph.roots.some((r) => r.id === unrelated.id));

        const completeAndReview = async (workerClient, item, attemptId) => {
          await invoke(workerClient, 'work.claim', { id: item.id });
          await invoke(workerClient, 'work.start', { id: item.id });
          await invoke(workerClient, 'work.evidence', {
            id: item.id,
            planVersion: item.plan_version,
            stepId: item.plan.steps[0].id,
            attemptId,
            outcome: 'passed',
            output: `Completed ${item.title}`,
            provenance: `fixture://${attemptId}`,
          });
          await invoke(workerClient, 'work.review', {
            id: item.id,
            summary: `Ready to accept ${item.title}`,
          });
        };

        // Move branchB to needs_review (needs_you) and complete+accept leafA so branchA becomes ready.
        await completeAndReview(b.client, branchB, 'branch-b-done');
        await completeAndReview(a.client, leafA, 'leaf-a-done');
        await invoke(f.owner, 'work.accept', { id: leafA.id, summary: 'Accepted leafA' });

        // Tie-break check: branchB (needs_you, unblocks 1) must appear ahead of branchA (ready, unblocks 1).
        const midGraph = await invoke(a.client, 'work.graph', {
          projectId: dagProject.id,
          rootId: root.id,
        });
        const midById = new Map(midGraph.nodes.map((n) => [n.id, n]));
        assert.deepEqual(midById.get(branchA.id).waiting, { satisfied: 1, total: 1 });
        assert.equal(midById.get(branchA.id).claimable, true);
        assert.equal(midById.get(branchA.id).uiState, 'ready');
        assert.equal(midById.get(branchB.id).uiState, 'needs_you');
        assert.deepEqual(midById.get(root.id).waiting, { satisfied: 0, total: 2 });
        assert.equal(midById.get(root.id).claimable, false);
        assert.deepEqual(midGraph.next, [branchB.id, branchA.id]);

        // Accept branchB and verify root waiting ratio advances to 1/2.
        await invoke(f.owner, 'work.accept', { id: branchB.id, summary: 'Accepted branchB' });
        const halfGraph = await invoke(a.client, 'work.graph', {
          projectId: dagProject.id,
          rootId: root.id,
        });
        assert.deepEqual(halfGraph.nodes.find((n) => n.id === root.id).waiting, {
          satisfied: 1,
          total: 2,
        });
        assert.equal(halfGraph.nodes.find((n) => n.id === root.id).claimable, false);

        // Complete and accept branchA (on its bumped plan_version 2 from fork2).
        await completeAndReview(a.client, fork2.parent, 'branch-a-done');
        await invoke(f.owner, 'work.accept', { id: branchA.id, summary: 'Accepted branchA' });

        // All forked branches are accepted: root must flip to claimable: true (uiState: 'ready').
        const unblockedGraph = await invoke(a.client, 'work.graph', {
          projectId: dagProject.id,
          rootId: root.id,
        });
        const readyRoot = unblockedGraph.nodes.find((n) => n.id === root.id);
        assert.deepEqual(readyRoot.waiting, { satisfied: 2, total: 2 });
        assert.equal(readyRoot.claimable, true);
        assert.equal(readyRoot.uiState, 'ready');
        assert.deepEqual(unblockedGraph.next, [root.id]);
        assert.ok(unblockedGraph.edges.every((e) => e.satisfied === true && e.active === false));

        // Claim the unblocked root and prove pre-fork v1 evidence cannot satisfy acceptance on bumped plan_version 2.
        await invoke(a.client, 'work.claim', { id: root.id });
        await invoke(a.client, 'work.start', { id: root.id });
        await reject(
          () =>
            invoke(a.client, 'work.evidence', {
              id: root.id,
              planVersion: 1,
              stepId: root.plan.steps[0].id,
              attemptId: 'stale-v1-attempt',
              outcome: 'passed',
              output: 'Stale plan version submission',
              provenance: 'fixture://stale-v1',
            }),
          'stale_plan',
        );
        await invoke(a.client, 'work.review', {
          id: root.id,
          summary: 'Attempt review with only pre-fork evidence',
        });
        await reject(
          () =>
            invoke(f.owner, 'work.accept', {
              id: root.id,
              summary: 'Old pre-fork evidence must not satisfy plan version 2',
            }),
          'evidence_incomplete',
        );
        const inspectedRoot = await invoke(f.owner, 'work.get', { id: root.id });
        assert.equal(inspectedRoot.plan_version, 2);
        assert.equal(inspectedRoot.coverage.state, 'unverified');
        assert.equal(inspectedRoot.evidence.length, 1);
      },
    );
    await t.test(
      'rich claimability diagnostics, structured 409 recovery payloads, and atomic active-lease work.fork work on PostgreSQL 17',
      async () => {
        const claimProject = await callCli(f, 'projects.create', {
          title: 'Claimability and active-lease fork project',
        });
        const activeParent = await createWork(f.owner, {
          title: 'Active lease fork parent',
          projectId: claimProject.id,
        });
        assert.equal(activeParent.claimable, true);
        assert.equal(activeParent.claimability.state, 'ready');
        assert.equal(activeParent.claimability.nextAction, 'work.claim');
        assert.deepEqual(activeParent.claimability.blockedBy, []);

        // Claim and start parent as agent A, recording pre-fork evidence on plan v1.
        await invoke(a.client, 'work.claim', { id: activeParent.id });
        const runningParent = await invoke(a.client, 'work.start', { id: activeParent.id });
        assert.equal(runningParent.claimable, false);
        assert.equal(runningParent.claimability.state, 'leased');
        assert.equal(runningParent.claimability.nextAction, 'wait_for_lease_or_reclaim');
        assert.deepEqual(runningParent.claimability.blockedBy, []);

        await invoke(a.client, 'work.evidence', {
          id: activeParent.id,
          planVersion: 1,
          stepId: activeParent.plan.steps[0].id,
          attemptId: 'active-pre-fork',
          outcome: 'passed',
          output: 'Passed before active-lease fork',
          provenance: 'fixture://active-pre-fork',
        });
        const runningInspected = await invoke(f.owner, 'work.get', { id: activeParent.id });
        assert.equal(runningInspected.claimability.state, 'leased');

        // Verify work.list and work.graph both surface claimability diagnostics.
        const listed = await invoke(a.client, 'work.list', { limit: 100, offset: 0 });
        const listedParent = listed.find((item) => item.id === activeParent.id);
        assert.equal(listedParent.claimable, false);
        assert.equal(listedParent.claimability.state, 'leased');

        const activeGraph = await invoke(a.client, 'work.graph', { projectId: claimProject.id });
        const activeGraphNode = activeGraph.nodes.find((n) => n.id === activeParent.id);
        assert.equal(activeGraphNode.claimable, false);
        assert.equal(activeGraphNode.claimability.state, 'leased');

        // Non-holder (agent B) attempting work.fork on leased item gets 409 stale_lease with hints.
        await assert.rejects(
          () =>
            invoke(b.client, 'work.fork', {
              id: activeParent.id,
              revision: runningInspected.revision,
              reason: 'Unauthorized non-holder fork attempt',
              branches: [{ title: 'Unauthorized branch' }],
            }),
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, 'stale_lease');
            assert.ok(Array.isArray(err.suggestions) && err.suggestions.length > 0);
            assert.equal(err.details?.workId, activeParent.id);
            assert.equal(err.details?.status, 'running');
            assert.equal('claimSecret' in (err.details ?? {}), false);
            return true;
          },
        );

        // Active lease holder with stale revision gets structured 409 revision_conflict.
        await assert.rejects(
          () =>
            invoke(a.client, 'work.fork', {
              id: activeParent.id,
              revision: runningInspected.revision - 1,
              reason: 'Stale revision active-lease fork',
              branches: [{ title: 'Should not create' }],
            }),
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, 'revision_conflict');
            assert.ok(Array.isArray(err.suggestions) && err.suggestions.length > 0);
            assert.equal(err.details?.expectedRevision, runningInspected.revision - 1);
            assert.equal(err.details?.actualRevision, runningInspected.revision);
            return true;
          },
        );

        // Structured 409 on work.update and work.dependencies.set while actively leased.
        await assert.rejects(
          () =>
            invoke(f.owner, 'work.update', {
              id: activeParent.id,
              revision: runningInspected.revision,
              title: 'Cannot edit while running',
              description: 'Blocked by active lease',
              reason: 'Probe active edit 409',
            }),
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, 'invalid_transition');
            assert.ok(Array.isArray(err.suggestions) && err.suggestions.length > 0);
            assert.equal(err.details?.claimability?.state, 'leased');
            return true;
          },
        );

        // Active lease holder calls work.fork atomically (client auto-attaches saved lease custody).
        const activeForkKey = 'active-lease-fork-atomic-1';
        const activeFork = await invoke(
          a.client,
          'work.fork',
          {
            id: activeParent.id,
            revision: runningInspected.revision,
            reason: 'Split active work atomically into two branches',
            branches: [
              { title: 'Active Branch 1', description: 'Will fail to test dependency_failed' },
              { title: 'Active Branch 2', description: 'Will test claimed-state active fork' },
            ],
          },
          activeForkKey,
        );
        assert.equal(activeFork.parent.status, 'queued');
        assert.equal(activeFork.parent.expires_at, null);
        assert.equal(activeFork.parent.claimable, false);
        assert.equal(activeFork.parent.plan_version, 2);
        assert.equal(activeFork.parent.revision, runningInspected.revision + 1);
        assert.equal(activeFork.parent.coverage.state, 'unverified');
        assert.equal(activeFork.parent.claimability.state, 'waiting');
        assert.equal(activeFork.parent.claimability.nextAction, 'wait_for_dependencies');
        assert.equal(activeFork.parent.claimability.blockedBy.length, 2);
        assert.equal(activeFork.branches.length, 2);
        for (const branch of activeFork.branches) {
          assert.equal(branch.claimable, true);
          assert.equal(branch.claimability.state, 'ready');
          assert.ok(
            branch.links.some(
              (l) => l.relation === 'belongs_to' && l.target_id === claimProject.id,
            ),
          );
        }

        // Idempotent retry with same requestKey replays the exact result after lease release.
        const activeForkReplay = await invoke(
          a.client,
          'work.fork',
          {
            id: activeParent.id,
            revision: runningInspected.revision,
            reason: 'Split active work atomically into two branches',
            branches: [
              { title: 'Active Branch 1', description: 'Will fail to test dependency_failed' },
              { title: 'Active Branch 2', description: 'Will test claimed-state active fork' },
            ],
          },
          activeForkKey,
        );
        assert.deepEqual(activeForkReplay, activeFork);

        // Old lease is released and work.fork history event notes releasedLease: true.
        await reject(
          () => invoke(a.client, 'work.heartbeat', { id: activeParent.id }),
          'stale_lease',
        );
        const forkedParentDetail = await invoke(f.owner, 'work.get', { id: activeParent.id });
        const forkEvent = forkedParentDetail.history.find((e) => e.event === 'work.fork');
        assert.equal(forkEvent?.detail?.releasedLease, true);

        // Structured 409 revision_conflict on work.dependencies.set.
        await assert.rejects(
          () =>
            invoke(f.owner, 'work.dependencies.set', {
              id: activeParent.id,
              revision: forkedParentDetail.revision - 1,
              dependencies: [],
              reason: 'Stale revision probe on dependencies.set',
            }),
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, 'revision_conflict');
            assert.equal(err.details?.expectedRevision, forkedParentDetail.revision - 1);
            assert.equal(err.details?.actualRevision, forkedParentDetail.revision);
            assert.ok(Array.isArray(err.suggestions) && err.suggestions.length > 0);
            return true;
          },
        );

        // Fail Branch 1 -> parent flips to dependency_failed, and work.claim returns rich 409 not_claimable.
        const [branch1, branch2] = activeFork.branches;
        await invoke(a.client, 'work.claim', { id: branch1.id });
        const failedBranch1 = await invoke(a.client, 'work.fail', {
          id: branch1.id,
          reason: 'Synthetic branch failure',
        });
        assert.equal(failedBranch1.claimability.state, 'terminal');

        const parentAfterFail = await invoke(f.owner, 'work.get', { id: activeParent.id });
        assert.equal(parentAfterFail.claimable, false);
        assert.equal(parentAfterFail.claimability.state, 'dependency_failed');
        assert.equal(parentAfterFail.claimability.nextAction, 'unblock_or_requeue_predecessor');
        assert.ok(
          parentAfterFail.claimability.blockedBy.some(
            (dep) => dep.workId === branch1.id && dep.status === 'failed',
          ),
        );
        const failGraph = await invoke(a.client, 'work.graph', { projectId: claimProject.id });
        assert.equal(
          failGraph.nodes.find((n) => n.id === activeParent.id).claimability.state,
          'dependency_failed',
        );

        await assert.rejects(
          () => invoke(a.client, 'work.claim', { id: activeParent.id }),
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, 'not_claimable');
            assert.ok(Array.isArray(err.suggestions) && err.suggestions.length > 0);
            assert.equal(err.details?.claimability?.state, 'dependency_failed');
            assert.ok(err.details?.unmetPredecessorIds?.includes(branch1.id));
            return true;
          },
        );

        // Unleased work.fork on a failed item succeeds without lease custody.
        const failedFork = await invoke(a.client, 'work.fork', {
          id: branch1.id,
          revision: failedBranch1.revision,
          reason: 'Recover failed branch by splitting',
          branches: [{ title: 'Recovery leaf' }],
        });
        assert.equal(failedFork.parent.status, 'queued');
        assert.equal(failedFork.parent.claimability.state, 'waiting');

        // Active-lease work.fork directly from 'claimed' state (without work.start) also succeeds.
        const claimedBranch2 = await invoke(b.client, 'work.claim', { id: branch2.id });
        assert.equal(claimedBranch2.status, 'claimed');
        const claimedFork = await invoke(b.client, 'work.fork', {
          id: branch2.id,
          revision: claimedBranch2.revision,
          reason: 'Fork directly from claimed lease',
          branches: [{ title: 'Claimed sub-leaf' }],
        });
        assert.equal(claimedFork.parent.status, 'queued');
        assert.equal(claimedFork.parent.expires_at, null);
        assert.equal(claimedFork.parent.claimability.state, 'waiting');

        // Expired lease reports lease_expired (claimable: true) and rejects stale-lease work.fork.
        const expiringItem = await createWork(f.owner, {
          title: 'Short lease expiry probe',
          projectId: claimProject.id,
        });
        const shortClaim = await invoke(a.client, 'work.claim', {
          id: expiringItem.id,
          leaseSeconds: 1,
        });
        await new Promise((r) => setTimeout(r, 1100));
        const expiredView = await invoke(f.owner, 'work.get', { id: expiringItem.id });
        assert.equal(expiredView.claimable, true);
        assert.equal(expiredView.claimability.state, 'lease_expired');
        assert.equal(expiredView.claimability.nextAction, 'work.claim');
        const expiredGraph = await invoke(a.client, 'work.graph', { projectId: claimProject.id });
        assert.equal(
          expiredGraph.nodes.find((n) => n.id === expiringItem.id).claimability.state,
          'lease_expired',
        );
        await assert.rejects(
          () =>
            invoke(a.client, 'work.fork', {
              id: expiringItem.id,
              revision: shortClaim.revision,
              reason: 'Expired lease fork must fail',
              branches: [{ title: 'Should not create on expired lease' }],
            }),
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, 'stale_lease');
            assert.equal(err.details?.leaseExpired, true);
            assert.ok(Array.isArray(err.suggestions) && err.suggestions.length > 0);
            return true;
          },
        );
      },
    );
    await t.test(
      'metadata-only work.update preserves passing evidence, records field diffs, and agent reads sanitize bidi/secrets',
      async () => {
        const metaProject = await callCli(f, 'projects.create', {
          title: 'Metadata and read redaction project',
        });
        let item = await createWork(f.owner, {
          title: 'Metadata update target',
          description: 'Initial contract description',
          projectId: metaProject.id,
          rank: 5,
          priority: 'normal',
          labels: ['  wave-4 ', 'backend', 'wave-4'],
        });
        assert.equal(item.rank, 5);
        assert.equal(item.priority, 'normal');
        assert.deepEqual(item.labels, ['wave-4', 'backend']);

        // Record passing verification evidence and release back to queued.
        await invoke(a.client, 'work.claim', { id: item.id });
        await invoke(a.client, 'work.evidence', {
          id: item.id,
          planVersion: item.plan_version,
          stepId: item.plan.steps[0].id,
          attemptId: 'meta-pass-1',
          outcome: 'passed',
          output: 'All verification checks passed',
          provenance: 'fixture://meta-evidence',
        });
        item = await invoke(a.client, 'work.release', { id: item.id });
        assert.equal(item.coverage.state, 'commands_passed');
        assert.equal(item.plan_version, 1);

        // Stale revision on metadata-only update still fails closed with 409 revision_conflict.
        await reject(
          () =>
            invoke(f.owner, 'work.update', {
              id: item.id,
              revision: item.revision - 1,
              rank: -10,
              reason: 'Stale metadata revision probe',
            }),
          'revision_conflict',
        );

        // Metadata-only update (including unchanged title) preserves plan_version and passing evidence.
        const revBeforeMeta = item.revision;
        item = await callCli(f, 'work.update', {
          id: item.id,
          revision: revBeforeMeta,
          title: item.title,
          rank: -10,
          priority: 'urgent',
          labels: ['p0', ' wave-4 ', 'p0'],
          reason: 'Promote priority without changing contract',
        });
        assert.equal(item.revision, revBeforeMeta + 1);
        assert.equal(item.plan_version, 1);
        assert.equal(item.coverage.state, 'commands_passed');
        assert.equal(item.rank, -10);
        assert.equal(item.priority, 'urgent');
        assert.deepEqual(item.labels, ['p0', 'wave-4']);

        const afterMetaDetail = await invoke(f.owner, 'work.get', { id: item.id });
        assert.equal(afterMetaDetail.plans.length, 1);
        const metaEvent = afterMetaDetail.history.findLast((e) => e.event === 'work.update');
        assert.deepEqual(metaEvent.detail.changedFields, ['rank', 'priority', 'labels']);
        assert.deepEqual(metaEvent.detail.before, {
          rank: 5,
          priority: 'normal',
          labels: ['wave-4', 'backend'],
        });
        assert.deepEqual(metaEvent.detail.after, {
          rank: -10,
          priority: 'urgent',
          labels: ['p0', 'wave-4'],
        });
        assert.equal(metaEvent.detail.invalidatedEvidence, false);

        // work.list and work.graph both surface updated rank, priority, and labels.
        const listed = await invoke(f.owner, 'work.list', { limit: 100, offset: 0 });
        const listedItem = listed.find((entry) => entry.id === item.id);
        assert.equal(listedItem.rank, -10);
        assert.equal(listedItem.priority, 'urgent');
        assert.deepEqual(listedItem.labels, ['p0', 'wave-4']);
        const graph = await invoke(f.owner, 'work.graph', { projectId: metaProject.id });
        const graphNode = graph.nodes.find((n) => n.id === item.id);
        assert.equal(graphNode.rank, -10);
        assert.equal(graphNode.priority, 'urgent');
        assert.deepEqual(graphNode.labels, ['p0', 'wave-4']);

        // Metadata-only update while leased is still rejected.
        const claimed = await invoke(a.client, 'work.claim', { id: item.id });
        await reject(
          () =>
            invoke(f.owner, 'work.update', {
              id: item.id,
              revision: claimed.revision,
              rank: 20,
              reason: 'Cannot edit while leased',
            }),
          'invalid_transition',
        );
        item = await invoke(a.client, 'work.release', { id: item.id });
        assert.equal(item.coverage.state, 'commands_passed');

        // Contract/intent update (title + steps) still bumps plan_version and invalidates evidence.
        item = await callCli(f, 'work.update', {
          id: item.id,
          revision: item.revision,
          title: 'Revised contract title',
          steps: [
            { key: 'check', title: 'Observable result', required: true },
            { key: 'extra', title: 'Second required gate', required: true },
          ],
          reason: 'Expand verification contract',
        });
        assert.equal(item.plan_version, 2);
        assert.equal(item.coverage.state, 'unverified');
        const afterIntentDetail = await invoke(f.owner, 'work.get', { id: item.id });
        assert.equal(afterIntentDetail.plans.length, 2);
        const intentEvent = afterIntentDetail.history.findLast((e) => e.event === 'work.update');
        assert.deepEqual(intentEvent.detail.changedFields, ['title', 'steps']);
        assert.equal(intentEvent.detail.before.title, 'Metadata update target');
        assert.equal(intentEvent.detail.after.title, 'Revised contract title');
        assert.equal(intentEvent.detail.before.steps.length, 1);
        assert.equal(intentEvent.detail.after.steps.length, 2);
        assert.equal(intentEvent.detail.invalidatedEvidence, true);

        // Agent reads strip invisible/bidi characters and redact pre-existing secrets while preserving UUIDs/timestamps/digests.
        const dirtyItem = await createWork(f.owner, {
          title: 'Audit\u202E bidi\u200B title\uFEFF',
          description: 'Clean before legacy injection',
          projectId: metaProject.id,
          rank: -1,
          priority: 'high',
          labels: ['sec\u200Burity'],
        });
        await invoke(a.client, 'work.claim', { id: dirtyItem.id });
        const artifactAdded = await invoke(a.client, 'work.artifacts.add', {
          id: dirtyItem.id,
          name: 'notes.md',
          mediaType: 'text/markdown',
          content: 'Check\u202E artifact\u200B text',
        });
        await invoke(a.client, 'work.release', { id: dirtyItem.id });

        // Simulate a legacy/pre-policy database row containing leaked credentials.
        const adminPool = new Pool({ connectionString: f.adminUrl });
        try {
          await adminPool.query('UPDATE work.items SET description=$2 WHERE id=$1', [
            dirtyItem.id,
            'Leaked sk-proj-abcdefghijklmnop123456 and ghp_1234567890abcdefghij123456 and Authorization: Bearer supersecret999 and token=raw_secret_val',
          ]);
        } finally {
          await adminPool.end();
        }

        const agentGet = await invoke(a.client, 'work.get', { id: dirtyItem.id });
        assert.equal(agentGet.id, dirtyItem.id);
        assert.equal(agentGet.title, 'Audit bidi title');
        assert.deepEqual(agentGet.labels, ['security']);
        assert.ok(agentGet.description.includes('[REDACTED]'));
        assert.ok(!agentGet.description.includes('sk-proj-'));
        assert.ok(!agentGet.description.includes('ghp_'));
        assert.ok(!agentGet.description.includes('supersecret999'));
        assert.ok(!agentGet.description.includes('raw_secret_val'));
        assert.equal(agentGet.artifacts.length, 1);
        assert.match(agentGet.artifacts[0].digest, /^[0-9a-f]{64}$/);

        const agentArtifact = await invoke(a.client, 'work.artifacts.get', {
          id: dirtyItem.id,
          artifactId: artifactAdded.artifactId,
        });
        assert.equal(agentArtifact.content, 'Check artifact text');
        assert.equal(agentArtifact.digest, agentGet.artifacts[0].digest);

        const agentGraph = await invoke(a.client, 'work.graph', { projectId: metaProject.id });
        const agentNode = agentGraph.nodes.find((n) => n.id === dirtyItem.id);
        assert.equal(agentNode.title, 'Audit bidi title');
        assert.ok(!agentNode.description.includes('sk-proj-'));
        assert.ok(agentNode.description.includes('[REDACTED]'));

        // Owner reads retain raw stored content for operator inspection/remediation.
        const ownerGet = await invoke(f.owner, 'work.get', { id: dirtyItem.id });
        assert.ok(ownerGet.title.includes('\u202E'));
        assert.ok(ownerGet.description.includes('sk-proj-'));
      },
    );
    await t.test(
      'tasks workSummary rollup, bounded links.graph with RLS, and live GET /v1/events SSE',
      async () => {
        // 1. Planning-without-work returns zeroed workSummary cleanly without touching work.items
        const planningOnly = await fixture('planning_no_work', ['projects', 'planning']);
        try {
          const pOnlyProj = await invoke(planningOnly.owner, 'projects.create', {
            title: 'Planning Only Project',
          });
          const pOnlyTask = await invoke(planningOnly.owner, 'tasks.create', {
            title: 'Task without work module',
            projectId: pOnlyProj.id,
          });
          const pOnlyGot = await invoke(planningOnly.owner, 'tasks.get', { id: pOnlyTask.id });
          assert.deepEqual(pOnlyGot.workSummary, {
            total: 0,
            done: 0,
            active: 0,
            ready: 0,
            needsReview: 0,
            blocked: 0,
            failed: 0,
          });
          const pOnlyListed = await invoke(planningOnly.owner, 'tasks.list', {
            projectId: pOnlyProj.id,
          });
          assert.equal(pOnlyListed.length, 1);
          assert.deepEqual(pOnlyListed[0].workSummary, pOnlyGot.workSummary);
        } finally {
          await stop(planningOnly);
        }

        // 2. Full rollup across statuses + deleted work excluded
        const rollupProj = await invoke(f.owner, 'projects.create', {
          title: 'Rollup & Links Graph Project',
        });
        const rollupTask = await invoke(f.owner, 'tasks.create', {
          title: 'Deliver live SSE and rollups',
          projectId: rollupProj.id,
        });
        const rollupNote = await invoke(f.owner, 'notes.create', {
          title: 'SSE design note',
          body: 'Post-commit pg_notify drives SSE updates',
          projectId: rollupProj.id,
        });

        const wReady = await createWork(f.owner, {
          title: 'Rollup ready',
          projectId: rollupProj.id,
          taskId: rollupTask.id,
          contextIds: [rollupNote.id],
        });
        const wActive = await createWork(f.owner, {
          title: 'Rollup active',
          projectId: rollupProj.id,
          taskId: rollupTask.id,
        });
        await invoke(a.client, 'work.claim', { id: wActive.id });
        await invoke(a.client, 'work.start', { id: wActive.id });

        const wBlocked = await createWork(f.owner, {
          title: 'Rollup blocked',
          projectId: rollupProj.id,
          taskId: rollupTask.id,
        });
        await invoke(a.client, 'work.claim', { id: wBlocked.id });
        await invoke(a.client, 'work.block', { id: wBlocked.id, reason: 'Waiting on spec' });

        const wFailed = await createWork(f.owner, {
          title: 'Rollup failed',
          projectId: rollupProj.id,
          taskId: rollupTask.id,
        });
        await invoke(a.client, 'work.claim', { id: wFailed.id });
        await invoke(a.client, 'work.fail', { id: wFailed.id, reason: 'Broken build' });

        const wReview = await createWork(f.owner, {
          title: 'Rollup review',
          projectId: rollupProj.id,
          taskId: rollupTask.id,
        });
        await invoke(a.client, 'work.claim', { id: wReview.id });
        await invoke(a.client, 'work.start', { id: wReview.id });
        await invoke(a.client, 'work.evidence', {
          id: wReview.id,
          planVersion: 1,
          stepId: wReview.plan.steps[0].id,
          attemptId: 'att-review',
          outcome: 'passed',
          output: 'ok',
          provenance: 'test',
        });
        await invoke(a.client, 'work.review', { id: wReview.id, summary: 'Ready for review' });

        const wDone = await createWork(f.owner, {
          title: 'Rollup done',
          projectId: rollupProj.id,
          taskId: rollupTask.id,
        });
        await invoke(a.client, 'work.claim', { id: wDone.id });
        await invoke(a.client, 'work.start', { id: wDone.id });
        await invoke(a.client, 'work.evidence', {
          id: wDone.id,
          planVersion: 1,
          stepId: wDone.plan.steps[0].id,
          attemptId: 'att-done',
          outcome: 'passed',
          output: 'ok',
          provenance: 'test',
        });
        await invoke(a.client, 'work.review', { id: wDone.id, summary: 'Complete' });
        await invoke(f.owner, 'work.accept', { id: wDone.id, summary: 'Accepted' });

        const wDeleted = await createWork(f.owner, {
          title: 'Rollup deleted',
          projectId: rollupProj.id,
          taskId: rollupTask.id,
        });
        const wCancelled = await invoke(f.owner, 'work.cancel', {
          id: wDeleted.id,
          reason: 'Cancel before soft-delete',
        });
        await invoke(f.owner, 'work.delete', {
          id: wDeleted.id,
          revision: wCancelled.revision,
          reason: 'Remove from rollup',
        });

        const expectedSummary = {
          total: 6,
          done: 1,
          active: 1,
          ready: 1,
          needsReview: 1,
          blocked: 1,
          failed: 1,
        };
        const gotTask = await invoke(f.owner, 'tasks.get', { id: rollupTask.id });
        assert.deepEqual(gotTask.workSummary, expectedSummary);
        const listedTasks = await invoke(f.owner, 'tasks.list', { projectId: rollupProj.id });
        assert.equal(listedTasks.length, 1);
        assert.deepEqual(listedTasks[0].workSummary, expectedSummary);

        // 3. Bounded links.graph depth 1..3, maxNodes truncation, includeDeleted & RLS/scope isolation
        const graphD1 = await invoke(f.owner, 'links.graph', {
          id: rollupTask.id,
          depth: 1,
        });
        assert.equal(graphD1.rootId, rollupTask.id);
        assert.equal(graphD1.depth, 1);
        assert.equal(graphD1.truncated, false);
        assert.ok(graphD1.nodes.some((n) => n.id === wReady.id && n.depth === 1));
        assert.equal(
          graphD1.nodes.some((n) => n.id === rollupNote.id),
          false,
          'Note is 2 hops from task (task <- work -> note)',
        );
        assert.equal(
          graphD1.nodes.some((n) => n.id === wDeleted.id),
          false,
          'Deleted node must be excluded when includeDeleted=false',
        );

        const graphD2 = await invoke(f.owner, 'links.graph', {
          id: rollupTask.id,
          depth: 2,
        });
        assert.ok(graphD2.nodes.some((n) => n.id === rollupNote.id && n.depth === 2));
        assert.ok(graphD2.nodes.some((n) => n.id === rollupProj.id && n.depth === 2));
        assert.ok(
          graphD2.edges.some(
            (e) =>
              e.sourceId === wReady.id &&
              e.targetId === rollupTask.id &&
              e.relation === 'implements',
          ),
        );

        const graphTrunc = await invoke(f.owner, 'links.graph', {
          id: rollupTask.id,
          depth: 3,
          maxNodes: 2,
        });
        assert.equal(graphTrunc.truncated, true);
        assert.equal(graphTrunc.nodes.length, 2);

        const graphWithDeleted = await invoke(f.owner, 'links.graph', {
          id: rollupTask.id,
          depth: 1,
          includeDeleted: true,
        });
        assert.equal(graphWithDeleted.nodes.find((n) => n.id === wDeleted.id)?.deleted, true);

        const scopeId = randomUUID();
        const scopedReader = await agent(
          f,
          'scoped_events_agent',
          ['foundation:read', 'context:read', 'context:write'],
          { scopeId },
        );
        await reject(
          () => invoke(scopedReader.client, 'links.graph', { id: rollupTask.id, depth: 2 }),
          'not_found',
        );

        // 4. Authenticated GET /v1/events SSE delivers post-commit writes & enforces owner/scope isolation
        const unauthRes = await fetch(new URL('/v1/events', f.url));
        assert.equal(unauthRes.status, 401);

        const ownerCred = await readCredentials(f.ownerPath);
        const scopedCred = await readCredentials(scopedReader.path);
        const ownerAbort = new AbortController();
        const scopedAbort = new AbortController();

        const openSse = async (cred, controller) => {
          const res = await fetch(new URL('/v1/events', f.url), {
            headers: { Authorization: `Bearer ${cred.token}` },
            signal: controller.signal,
          });
          assert.equal(res.status, 200);
          assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          const state = { buf: '' };
          const pump = (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                state.buf += decoder.decode(value, { stream: true });
              }
            } catch {
              // Aborted cleanly on teardown.
            }
          })();
          const waitFor = async (predicate, timeoutMs = 5000) => {
            const deadline = Date.now() + timeoutMs;
            while (!predicate(state.buf)) {
              if (Date.now() > deadline) {
                throw new Error(`Timed out waiting for SSE match. Buffer: ${state.buf}`);
              }
              await new Promise((r) => setTimeout(r, 20));
            }
          };
          await waitFor((buf) => buf.includes(': connected'));
          return { state, waitFor, pump };
        };

        try {
          const ownerSse = await openSse(ownerCred, ownerAbort);
          const scopedSse = await openSse(scopedCred, scopedAbort);

          // Owner committed write reaches owner SSE, never leaks to scoped agent
          await invoke(f.owner, 'notes.create', {
            title: 'Owner SSE probe',
            body: 'Delivered to personal owner stream only',
          });
          await ownerSse.waitFor(
            (buf) => buf.includes('event: update') && buf.includes('"notes.create"'),
          );
          await new Promise((r) => setTimeout(r, 150));
          assert.equal(
            scopedSse.state.buf.includes('event: update'),
            false,
            'Scoped agent must never receive personal-scope SSE events',
          );

          // Scoped committed write reaches scoped SSE with scopeId, never leaks to personal owner
          const ownerBufBeforeScoped = ownerSse.state.buf;
          await invoke(scopedReader.client, 'notes.create', {
            title: 'Scoped SSE probe',
            body: 'Delivered to scoped stream only',
          });
          await scopedSse.waitFor(
            (buf) =>
              buf.includes('event: update') &&
              buf.includes('"notes.create"') &&
              buf.includes(scopeId),
          );
          await new Promise((r) => setTimeout(r, 150));
          assert.equal(
            ownerSse.state.buf,
            ownerBufBeforeScoped,
            'Personal owner must never receive scoped-agent SSE events',
          );

          // Rolled-back write emits zero SSE notifications
          const ownerBufBeforeFail = ownerSse.state.buf;
          await reject(
            () =>
              invoke(f.owner, 'work.update', {
                id: wReady.id,
                revision: 999,
                title: 'Should roll back',
                description: '',
                reason: 'Stale revision rollback check',
              }),
            'revision_conflict',
          );
          await new Promise((r) => setTimeout(r, 150));
          assert.equal(
            ownerSse.state.buf,
            ownerBufBeforeFail,
            'Rolled-back write must not emit post-commit NOTIFY event',
          );
        } finally {
          ownerAbort.abort();
          scopedAbort.abort();
        }
      },
    );
    await t.test('restart preserves accepted work and idempotency receipts', async () => {
      await stop(f);
      await start(f);
      const recovered = await callCli(f, 'work.get', { id: work.id });
      assert.equal(recovered.status, 'done');
      assert.equal(recovered.evidence.length, 2);
      assert.equal(recovered.accepted_by, f.identity.principalId);
      assert.equal((await invoke(f.owner, 'notes.get', { id: note.id })).revision, 2);
      const before = await createWork(f.owner);
      await invoke(
        f.owner,
        'work.cancel',
        { id: before.id, reason: 'Synthetic cleanup' },
        'durable-cancel',
      );
      await stop(f);
      await start(f);
      assert.equal(
        (
          await invoke(
            f.owner,
            'work.cancel',
            { id: before.id, reason: 'Synthetic cleanup' },
            'durable-cancel',
          )
        ).status,
        'cancelled',
      );
    });
  } finally {
    for (const f of fixtures) await stop(f);
    const admin = new Pool({ connectionString: adminBase });
    for (const f of fixtures) await admin.query(`DROP DATABASE "${f.db}" WITH (FORCE)`);
    await admin.end();
  }
});
