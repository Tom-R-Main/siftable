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
    env: { PATH: process.env.PATH, SIFT_DATABASE_URL: f.runtimeUrl, PORT: '0' },
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
            12,
          );
          assert.ok((await callCli(legacy, 'modules.list', {})).every((m) => m.version === 2));
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
        const packet2 = await invoke(f.owner, 'context.packet', {
          noteIds: [note.id],
          maxChars: 10000,
        });
        assert.equal(packet2.manifest.items[0].revision, 1);
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
