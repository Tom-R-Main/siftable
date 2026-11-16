import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
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
async function fixture(label, modules) {
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
