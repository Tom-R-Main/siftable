import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { Ajv } from 'ajv';
import { operations } from '../packages/contracts/dist/index.js';
import { startGraphUiServer } from '../apps/graph-ui/dist/server.js';

const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'description',
  'title',
]);

function assertBoundedSchema(schema, depth = 0) {
  assert.ok(depth <= 8, 'Schema depth must not exceed 8');
  assert.ok(JSON.stringify(schema).length <= 20_000, 'Schema size must not exceed 20KB');
  for (const [key, value] of Object.entries(schema)) {
    assert.ok(ALLOWED_SCHEMA_KEYWORDS.has(key), `Unsupported schema keyword: ${key}`);
    if (key === 'properties') {
      assert.equal(typeof value, 'object');
      assert.ok(value && !Array.isArray(value));
      for (const [field, child] of Object.entries(value)) {
        assert.match(field, /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
        assertBoundedSchema(child, depth + 1);
      }
    }
    if (key === 'items' || (key === 'additionalProperties' && typeof value === 'object')) {
      assertBoundedSchema(value, depth + 1);
    }
  }
}

test('examples/harness-session.json conforms to Siftable extension schema rules', async () => {
  const raw = await readFile(resolve('examples/harness-session.json'), 'utf8');
  const doc = JSON.parse(raw);

  const parsed = operations['extensions.define'].input.parse(doc);
  assert.equal(parsed.type, 'harness.session');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.schema.type, 'object');
  assert.equal(parsed.schema.additionalProperties, false);
  assertBoundedSchema(parsed.schema);

  const props = parsed.schema.properties;
  assert.deepEqual(parsed.schema.required, ['harness', 'workId', 'threadId']);
  assert.deepEqual(props.harness.enum, [
    'antigravity',
    'codex',
    't3-code',
    'claude-code',
    'cursor',
    'cli',
    'other',
  ]);
  assert.deepEqual(props.mode.enum, ['discuss', 'build', 'review']);
  for (const field of [
    'harness',
    'workId',
    'threadId',
    'model',
    'mode',
    'branch',
    'worktreePath',
    'deepLink',
  ]) {
    assert.ok(props[field], `Expected property ${field}`);
  }

  const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
  const validate = ajv.compile(parsed.schema);

  assert.equal(
    validate({
      harness: 't3-code',
      workId: '7f1aaf41-07b4-49d8-ad42-7d24af9093d2',
      threadId: 't3_thr_01jq8x4k2m',
      model: 'claude-sonnet-4-6',
      mode: 'build',
      branch: 'feat/thread-links',
      worktreePath: '/tmp/wt-thread-links',
      deepLink: 'http://127.0.0.1:3773/threads/t3_thr_01jq8x4k2m',
    }),
    true,
  );
  assert.equal(
    validate({
      harness: 'unknown-runner',
      workId: '7f1aaf41-07b4-49d8-ad42-7d24af9093d2',
      threadId: 'thr-1',
    }),
    false,
  );
  assert.equal(
    validate({
      harness: 'codex',
      workId: '7f1aaf41-07b4-49d8-ad42-7d24af9093d2',
    }),
    false,
  );
  assert.equal(
    validate({
      harness: 'codex',
      workId: '7f1aaf41-07b4-49d8-ad42-7d24af9093d2',
      threadId: 'thr-1',
      extraField: 'not-allowed',
    }),
    false,
  );
});

test('graph-ui server serves HTML, DAG API, harness sessions, deep links, fork, accept, and handback artifacts', async () => {
  const runtime = await startGraphUiServer({ port: 0, forceDemo: true });
  try {
    const htmlRes = await fetch(runtime.url + '/');
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff');
    const html = await htmlRes.text();
    assert.match(html, /<title>Siftable Graph<\/title>/);
    assert.match(html, /new URLSearchParams\(window\.location\.search\)/);
    assert.match(html, /initialParams\.get\('workId'\)/);
    assert.match(html, /history\.replaceState/);
    assert.match(html, /Copy Link/);
    assert.match(html, /Linked Harness Sessions/);
    assert.match(html, /harness-chip/);
    assert.equal(
      /window\.(prompt|confirm|alert)\s*\(/.test(html),
      false,
      'Webview-blocked browser dialogs must not be used',
    );
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Expected inline script block');
    new vm.Script(scriptMatch[1]);

    // Verify inline isSafeDeepLink guard permits only safe schemes
    const safeFnMatch = scriptMatch[1].match(/function isSafeDeepLink\(raw\) \{[\s\S]*?\n  \}/);
    assert.ok(safeFnMatch, 'Expected isSafeDeepLink helper');
    const isSafeDeepLink = vm.runInNewContext(`(${safeFnMatch[0]})`, { URL });
    assert.equal(isSafeDeepLink('https://chatgpt.com/codex/tasks/task_9f2a1c'), true);
    assert.equal(isSafeDeepLink('http://127.0.0.1:3773/threads/t3_thr_01jq8x4k2m'), true);
    assert.equal(isSafeDeepLink('conversation://94884d9b-6c9e-4990-a4ca-d0fcda081ccc'), true);
    assert.equal(isSafeDeepLink('javascript:alert(1)'), false);
    assert.equal(isSafeDeepLink('http://example.com/phish'), false);
    assert.equal(isSafeDeepLink('data:text/html,<script>alert(1)</script>'), false);
    assert.equal(isSafeDeepLink('conversation://bad" onclick="alert(1)'), false);

    const graphRes = await fetch(runtime.url + '/api/graph');
    assert.equal(graphRes.status, 200);
    const graphBody = await graphRes.json();
    assert.equal(graphBody.mode, 'demo');
    assert.ok(graphBody.data.nodes.length >= 10);
    assert.equal(graphBody.data.roots.length, 2);
    assert.ok(graphBody.data.counts.next > 0);
    assert.equal(typeof graphBody.sessionsByWorkId, 'object');

    // Verify seeded demo harness sessions across antigravity, codex, and t3-code
    const allSessions = Object.values(graphBody.sessionsByWorkId).flat();
    assert.equal(allSessions.length, 3);
    const harnesses = new Set(allSessions.map((s) => s.harness));
    assert.deepEqual(harnesses, new Set(['antigravity', 'codex', 't3-code']));

    // Validate all demo sessions against examples/harness-session.json
    const schemaDoc = JSON.parse(await readFile(resolve('examples/harness-session.json'), 'utf8'));
    const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
    const validateSession = ajv.compile(schemaDoc.schema);
    for (const s of allSessions) {
      const { id: _id, ...payload } = s;
      assert.equal(validateSession(payload), true, `Invalid demo session payload for ${s.harness}`);
    }

    // Filter to second root
    const secondRoot = graphBody.data.roots.find((r) => r.title.includes('Recovery'));
    assert.ok(secondRoot);
    const filteredRes = await fetch(
      `${runtime.url}/api/graph?rootId=${encodeURIComponent(secondRoot.id)}`,
    );
    const filtered = await filteredRes.json();
    assert.equal(filtered.data.nodes.length, 3);
    assert.deepEqual(filtered.sessionsByWorkId, {});

    // Unlinked node returns empty sessions array
    const secondRootDetail = await (await fetch(`${runtime.url}/api/work/${secondRoot.id}`)).json();
    assert.deepEqual(secondRootDetail.sessions, []);

    // Accept a needs_review leaf and confirm its parent unlocks!
    const l2 = graphBody.data.nodes.find((n) => n.title.includes('Batched SQL'));
    assert.equal(l2.uiState, 'needs_you');
    const detailRes = await fetch(`${runtime.url}/api/work/${l2.id}`);
    const detail = await detailRes.json();
    assert.equal(detail.data.artifacts.length, 1);
    assert.equal(detail.sessions.length, 1);
    assert.equal(detail.sessions[0].harness, 'codex');
    assert.equal(detail.sessions[0].workId, l2.id);

    const l4 = graphBody.data.nodes.find((n) => n.title.includes('Handback artifact viewer'));
    const l4Detail = await (await fetch(`${runtime.url}/api/work/${l4.id}`)).json();
    assert.equal(l4Detail.sessions.length, 1);
    assert.equal(l4Detail.sessions[0].harness, 't3-code');
    assert.match(l4Detail.sessions[0].deepLink, /^http:\/\/127\.0\.0\.1:/);

    const artRes = await fetch(
      `${runtime.url}/api/work/${l2.id}/artifacts/${detail.data.artifacts[0].id}`,
    );
    const art = await artRes.json();
    assert.match(art.data.content, /Handback Summary/);

    const acceptRes = await fetch(`${runtime.url}/api/work/${l2.id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'Verified batched SQL query' }),
    });
    assert.equal(acceptRes.status, 200);

    const afterAccept = await (await fetch(runtime.url + '/api/graph')).json();
    const m1 = afterAccept.data.nodes.find((n) => n.title.includes('Graph Query & Metrics'));
    assert.equal(m1.uiState, 'ready');
    assert.deepEqual(m1.waiting, { satisfied: 2, total: 2 });

    // Fork a ready leaf and verify it transitions to waiting 0/2
    const l6 = afterAccept.data.nodes.find((n) => n.title.includes('sidecar.json'));
    const forkRes = await fetch(`${runtime.url}/api/work/${l6.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: l6.revision,
        reason: 'Split plugin manifests',
        branches: [
          { title: 'Write sidecar.json manifest', description: '' },
          { title: 'Write mcp_config.json manifest', description: '' },
        ],
      }),
    });
    assert.equal(forkRes.status, 200);

    const afterFork = await (await fetch(runtime.url + '/api/graph')).json();
    const l6After = afterFork.data.nodes.find((n) => n.id === l6.id);
    assert.equal(l6After.uiState, 'waiting');
    assert.deepEqual(l6After.waiting, { satisfied: 0, total: 2 });
  } finally {
    await runtime.close();
  }
});

test('graph-ui live mode loads harness.session objects and degrades cleanly when extensions are disabled', async () => {
  const workId = '7f1aaf41-07b4-49d8-ad42-7d24af9093d2';
  const sessionId = '40000000-0000-4000-8000-000000000001';
  let extensionsEnabled = true;

  const apiServer = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/catalog') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.url === '/v1/operations/work.graph') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: {
              nodes: [{ id: workId, title: 'Live work node', uiState: 'ready' }],
              edges: [],
              roots: [],
              next: [workId],
              counts: { total: 1, next: 1 },
            },
          }),
        );
        return;
      }
      if (req.url === '/v1/operations/projects.list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.url === '/v1/operations/work.get') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ data: { id: workId, title: 'Live work node', status: 'queued' } }),
        );
        return;
      }
      if (req.url === '/v1/operations/objects.list') {
        if (!extensionsEnabled) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: { code: 'module_disabled', message: 'Extensions disabled' } }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: sessionId,
                type: 'harness.session',
                version: 1,
                data: {
                  harness: 't3-code',
                  workId,
                  threadId: 't3_live_thread_1',
                  mode: 'build',
                  branch: 'feat/live-session',
                  deepLink: 'http://127.0.0.1:3773/threads/t3_live_thread_1',
                },
                revision: 1,
                deleted_at: null,
              },
              {
                id: '40000000-0000-4000-8000-000000000002',
                type: 'harness.session',
                version: 1,
                data: { harness: 'invalid-harness', workId, threadId: 'bad' },
                revision: 1,
                deleted_at: null,
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }));
    });
  });

  await new Promise((resolveListen) => apiServer.listen(0, '127.0.0.1', resolveListen));
  const apiAddr = apiServer.address();
  const dir = await mkdtemp(join(tmpdir(), 'sift-graph-ui-live-'));
  const configPath = join(dir, 'owner.json');
  await writeFile(
    configPath,
    JSON.stringify({
      ownerId: randomUUID(),
      principalId: randomUUID(),
      scopeId: null,
      apiUrl: `http://127.0.0.1:${apiAddr.port}`,
      token: 'live-test-token-value-with-sufficient-length-32chars',
    }),
    { mode: 0o600 },
  );

  const runtime = await startGraphUiServer({ port: 0, configPath, forceDemo: false });
  try {
    const graphRes = await fetch(runtime.url + '/api/graph');
    assert.equal(graphRes.status, 200);
    const graphBody = await graphRes.json();
    assert.equal(graphBody.mode, 'live');
    assert.equal(graphBody.sessionsByWorkId[workId].length, 1);
    assert.equal(graphBody.sessionsByWorkId[workId][0].id, sessionId);
    assert.equal(graphBody.sessionsByWorkId[workId][0].harness, 't3-code');

    const workRes = await fetch(`${runtime.url}/api/work/${workId}`);
    assert.equal(workRes.status, 200);
    const workBody = await workRes.json();
    assert.equal(workBody.mode, 'live');
    assert.equal(workBody.sessions.length, 1);
    assert.equal(workBody.sessions[0].threadId, 't3_live_thread_1');

    // Now simulate extensions module disabled: API must still succeed with empty sessions
    extensionsEnabled = false;
    const graphFallback = await (await fetch(runtime.url + '/api/graph')).json();
    assert.equal(graphFallback.mode, 'live');
    assert.deepEqual(graphFallback.sessionsByWorkId, {});

    const workFallback = await (await fetch(`${runtime.url}/api/work/${workId}`)).json();
    assert.equal(workFallback.mode, 'live');
    assert.deepEqual(workFallback.sessions, []);
  } finally {
    await runtime.close();
    await new Promise((resolveClose) => apiServer.close(resolveClose));
    await rm(dir, { recursive: true, force: true });
  }
});
