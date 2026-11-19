import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { operations, SiftError } from '../packages/contracts/dist/index.js';
import { buildWorkGraph } from '../packages/core/dist/index.js';
import {
  toolAnnotations,
  formatToolResultText,
  formatToolError,
  recoveryHint,
} from '../packages/mcp/dist/format.js';

const rootId = randomUUID();
const childReadyId = randomUUID();
const childReviewId = randomUUID();
const childDoneId = randomUUID();

const unverifiedCoverage = {
  state: 'unverified',
  required: 1,
  covered: 0,
  passed: 0,
  missingStepIds: [],
  failedStepIds: [],
  steps: [],
};

const passedCoverage = {
  state: 'commands_passed',
  required: 1,
  covered: 1,
  passed: 1,
  missingStepIds: [],
  failedStepIds: [],
  steps: [],
};

function sampleGraph() {
  return buildWorkGraph(
    [
      {
        id: rootId,
        revision: 3,
        title: 'Ship MCP ergonomics',
        description: 'Verbose description kept in structuredContent only '.repeat(20),
        status: 'queued',
        plan_version: 2,
        summary: null,
        claimable: false,
        deleted_at: null,
        created_at: '2026-11-19T12:00:00.000Z',
        coverage: unverifiedCoverage,
        links: [],
        artifactCount: 0,
      },
      {
        id: childReadyId,
        revision: 1,
        title: 'Attach tool annotations',
        description: 'Detailed branch instructions '.repeat(20),
        status: 'queued',
        plan_version: 1,
        summary: null,
        claimable: true,
        deleted_at: null,
        created_at: '2026-11-19T12:01:00.000Z',
        coverage: unverifiedCoverage,
        links: [],
        artifactCount: 0,
      },
      {
        id: childReviewId,
        revision: 4,
        title: 'Verify recovery hints',
        description: 'Detailed review notes '.repeat(20),
        status: 'needs_review',
        plan_version: 1,
        summary: 'Ready for review',
        claimable: false,
        deleted_at: null,
        created_at: '2026-11-19T12:02:00.000Z',
        coverage: passedCoverage,
        links: [],
        artifactCount: 1,
      },
      {
        id: childDoneId,
        revision: 5,
        title: 'Design contract mapping',
        description: 'Completed milestone '.repeat(20),
        status: 'done',
        plan_version: 1,
        summary: 'Accepted',
        claimable: false,
        deleted_at: null,
        created_at: '2026-11-19T11:55:00.000Z',
        coverage: passedCoverage,
        links: [],
        artifactCount: 1,
      },
    ],
    [
      { work_id: rootId, predecessor_id: childReadyId, gate: 'done', satisfied: false },
      { work_id: rootId, predecessor_id: childReviewId, gate: 'done', satisfied: false },
      { work_id: rootId, predecessor_id: childDoneId, gate: 'done', satisfied: true },
    ],
  );
}

function sampleWorkList() {
  return [
    {
      id: childReadyId,
      revision: 1,
      title: 'Attach tool annotations',
      description: 'Detailed work description '.repeat(15),
      status: 'queued',
      plan_version: 1,
      claimable: true,
      coverage: unverifiedCoverage,
      links: [],
    },
    {
      id: childReviewId,
      revision: 4,
      title: 'Verify recovery hints',
      description: 'Detailed review description '.repeat(15),
      status: 'needs_review',
      plan_version: 1,
      claimable: false,
      coverage: passedCoverage,
      links: [],
    },
  ];
}

test('toolAnnotations derives accurate MCP hints for every contract operation', () => {
  const destructiveOps = new Set();
  for (const [name, op] of Object.entries(operations)) {
    const ann = toolAnnotations(name);
    assert.equal(ann.readOnlyHint, !op.write, `${name}: readOnlyHint`);
    assert.equal(ann.idempotentHint, true, `${name}: idempotentHint`);
    assert.equal(ann.openWorldHint, false, `${name}: openWorldHint`);
    const expectedDestructive =
      op.write && (name.endsWith('.delete') || name === 'work.cancel' || name === 'work.fail');
    assert.equal(ann.destructiveHint, expectedDestructive, `${name}: destructiveHint`);
    if (ann.destructiveHint) destructiveOps.add(name);
  }
  assert.deepEqual([...destructiveOps].sort(), [
    'notes.delete',
    'objects.delete',
    'projects.delete',
    'relations.delete',
    'tasks.delete',
    'work.cancel',
    'work.delete',
    'work.fail',
  ]);
});

test('formatToolResultText and formatToolError handle edge cases cleanly', () => {
  const emptyGraph = buildWorkGraph([], []);
  assert.equal(formatToolResultText('work.graph', emptyGraph), 'Work graph: 0 items.');
  assert.equal(formatToolResultText('work.list', []), 'Work list: 0 items.');
  assert.equal(
    formatToolResultText('work.get', { id: 'abc', title: 'X' }),
    '{"id":"abc","title":"X"}',
  );

  const conflict = formatToolError(
    new SiftError(409, 'revision_conflict', 'Work revision changed'),
  );
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.error.code, 'revision_conflict');
  assert.equal(conflict.structuredContent.error.status, 409);
  assert.match(conflict.structuredContent.error.recovery, /latest revision/i);
  assert.match(conflict.content[0].text, /\[revision_conflict\] Work revision changed/);
  assert.match(conflict.content[0].text, /Recovery:/);

  const fallback = formatToolError(new SiftError(500, 'unexpected_custom_code', 'Boom'));
  assert.equal(fallback.structuredContent.error.recovery, recoveryHint('unexpected_custom_code'));

  const missingLease = formatToolError(
    new Error('No saved lease: claim this work with this credential first'),
  );
  assert.equal(missingLease.structuredContent.error.code, 'missing_lease');
  assert.match(missingLease.structuredContent.error.recovery, /work_claim/);
});

test('stdio MCP server emits annotations, compact projections, canonical structuredContent, and error recovery', async () => {
  const graphFixture = sampleGraph();
  const listFixture = sampleWorkList();
  const getFixture = {
    id: childReadyId,
    revision: 1,
    title: 'Attach tool annotations',
    status: 'queued',
    claimable: true,
    plan_version: 1,
  };

  const catalogEntries = [
    { name: 'work.graph', module: 'work', write: false },
    { name: 'work.list', module: 'work', write: false },
    { name: 'work.get', module: 'work', write: false },
    { name: 'work.lease', module: 'work', write: false },
    { name: 'work.claim', module: 'work', write: true },
    { name: 'work.update', module: 'work', write: true },
    { name: 'work.fail', module: 'work', write: true },
    { name: 'work.cancel', module: 'work', write: true },
    { name: 'work.delete', module: 'work', write: true },
    { name: 'notes.delete', module: 'context', write: true },
  ];

  const token = randomBytes(24).toString('hex');
  const mockServer = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Bad token' } }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/catalog') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: catalogEntries }));
      return;
    }

    if (req.method === 'POST' && req.url?.startsWith('/v1/operations/')) {
      const op = req.url.slice('/v1/operations/'.length);
      for await (const _chunk of req) {
        // drain request body
      }
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (op === 'work.graph') return send(200, { data: graphFixture });
      if (op === 'work.list') return send(200, { data: listFixture });
      if (op === 'work.get') return send(200, { data: getFixture });
      if (op === 'work.update') {
        return send(409, {
          error: { code: 'revision_conflict', message: 'Work revision changed' },
        });
      }
      if (op === 'work.claim') {
        return send(409, {
          error: {
            code: 'not_claimable',
            message: 'Work is terminal, leased, in review, or waiting for dependencies',
          },
        });
      }
      if (op === 'work.lease') {
        return send(409, {
          error: {
            code: 'stale_lease',
            message: 'An active lease owned by this principal is required',
          },
        });
      }
      if (op === 'work.cancel') {
        return send(409, {
          error: {
            code: 'idempotency_conflict',
            message: 'Idempotency key already used with different input',
          },
        });
      }
      return send(404, { error: { code: 'unknown_operation', message: 'Unknown operation' } });
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }));
  });

  await new Promise((resolveListen) => mockServer.listen(0, '127.0.0.1', resolveListen));
  const address = mockServer.address();
  assert.ok(address && typeof address === 'object');
  const apiUrl = `http://127.0.0.1:${address.port}`;

  const tempDir = await mkdtemp(join(tmpdir(), 'sift-mcp-ergonomics-'));
  const credPath = join(tempDir, 'cred.json');
  await writeFile(
    credPath,
    JSON.stringify({
      apiUrl,
      token,
      principalId: randomUUID(),
      ownerId: randomUUID(),
      scopeId: null,
    }),
    { mode: 0o600 },
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('packages/mcp/dist/index.js')],
    cwd: resolve('.'),
    env: { PATH: process.env.PATH ?? '', SIFT_CONFIG: credPath },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'mcp-ergonomics-test', version: '1.0.0' });

  try {
    await client.connect(transport);

    // 1. Verify listTools annotations across read, write, and destructive operations
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    assert.deepEqual(byName.get('work_graph').annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.deepEqual(byName.get('work_claim').annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const destructive of ['work_fail', 'work_cancel', 'work_delete', 'notes_delete']) {
      assert.deepEqual(
        byName.get(destructive).annotations,
        {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        `${destructive} annotations`,
      );
    }

    // 2. Verify work_graph compact text projection AND canonical structuredContent.data
    const graphRes = await client.callTool({ name: 'work_graph', arguments: {} });
    assert.equal(graphRes.isError, undefined);
    const graphText = graphRes.content[0].text;
    assert.match(
      graphText,
      /^Work graph: 4 items \(ready=1, needs_you=1, active=0, waiting=1, done=1\)/,
    );
    assert.match(graphText, /Next frontier \(2\):/);
    assert.match(graphText, /\[needs_you\].*Verify recovery hints/);
    assert.match(graphText, /\[ready\].*Attach tool annotations.*claimable/);
    assert.match(graphText, /deps=1\/3/);
    assert.ok(
      graphText.length < JSON.stringify(graphFixture).length / 2,
      'work_graph text should be substantially more compact than raw JSON',
    );
    assert.deepEqual(graphRes.structuredContent.data, graphFixture);

    // 3. Verify work_list compact text projection AND canonical structuredContent.data
    const listRes = await client.callTool({ name: 'work_list', arguments: {} });
    assert.equal(listRes.isError, undefined);
    const listText = listRes.content[0].text;
    assert.match(listText, /^Work list \(2 items\):/);
    assert.match(
      listText,
      /\[queued, claimable\].*Attach tool annotations.*rev=1, plan=v1, coverage=unverified/,
    );
    assert.match(
      listText,
      /\[needs_review\].*Verify recovery hints.*rev=4, plan=v1, coverage=commands_passed/,
    );
    assert.deepEqual(listRes.structuredContent.data, listFixture);

    // 4. Verify other tools keep canonical JSON in content[0].text and structuredContent.data
    const getRes = await client.callTool({ name: 'work_get', arguments: { id: childReadyId } });
    assert.equal(getRes.isError, undefined);
    assert.deepEqual(JSON.parse(getRes.content[0].text), getFixture);
    assert.deepEqual(getRes.structuredContent.data, getFixture);

    // 5. Verify structured SiftError recovery responses
    const revConflict = await client.callTool({
      name: 'work_update',
      arguments: {
        id: rootId,
        revision: 1,
        title: 'Stale edit',
        description: '',
        reason: 'test',
        requestKey: 'rk-rev-1',
      },
    });
    assert.equal(revConflict.isError, true);
    assert.match(revConflict.content[0].text, /\[revision_conflict\] Work revision changed/);
    assert.match(revConflict.content[0].text, /Recovery:.*revision.*requestKey/i);
    assert.equal(revConflict.structuredContent.error.code, 'revision_conflict');
    assert.equal(revConflict.structuredContent.error.status, 409);
    assert.match(revConflict.structuredContent.error.recovery, /latest revision/i);

    const notClaimable = await client.callTool({
      name: 'work_claim',
      arguments: { id: rootId, requestKey: 'rk-claim-1' },
    });
    assert.equal(notClaimable.isError, true);
    assert.match(notClaimable.content[0].text, /\[not_claimable\]/);
    assert.match(notClaimable.content[0].text, /Recovery:.*work_graph/i);
    assert.equal(notClaimable.structuredContent.error.code, 'not_claimable');

    const staleLease = await client.callTool({
      name: 'work_fail',
      arguments: { id: rootId, reason: 'lost lease', requestKey: 'rk-fail-1' },
    });
    assert.equal(staleLease.isError, true);
    assert.match(staleLease.content[0].text, /\[stale_lease\]/);
    assert.match(staleLease.content[0].text, /Recovery:.*work_claim/i);
    assert.equal(staleLease.structuredContent.error.code, 'stale_lease');

    const idemConflict = await client.callTool({
      name: 'work_cancel',
      arguments: { id: rootId, reason: 'changed input', requestKey: 'rk-idem-1' },
    });
    assert.equal(idemConflict.isError, true);
    assert.match(idemConflict.content[0].text, /\[idempotency_conflict\]/);
    assert.match(idemConflict.content[0].text, /Recovery:.*new requestKey/i);
    assert.equal(idemConflict.structuredContent.error.code, 'idempotency_conflict');

    const unavailable = await client.callTool({
      name: 'work_accept',
      arguments: { id: rootId, summary: 'not visible', requestKey: 'rk-unavail-1' },
    });
    assert.equal(unavailable.isError, true);
    assert.equal(unavailable.structuredContent.error.code, 'tool_unavailable');
    assert.match(unavailable.content[0].text, /Recovery:.*listTools/i);
  } finally {
    await client.close();
    await new Promise((resolveClose) => mockServer.close(resolveClose));
    await rm(tempDir, { recursive: true, force: true });
  }
});
