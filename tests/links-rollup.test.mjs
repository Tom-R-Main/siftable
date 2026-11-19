import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allowed, operations } from '../packages/contracts/dist/index.js';
import {
  buildBoundedLinksGraph,
  emptyTaskWorkSummary,
  isDomainEventVisibleToPrincipal,
  parseDomainEventPayload,
  summarizeTaskWork,
} from '../packages/core/dist/index.js';

test('links.graph contract enforces bounds, defaults, strict schema, and foundation:read permissions', () => {
  const contract = operations['links.graph'];
  assert.ok(contract);
  assert.equal(contract.module, 'foundation');
  assert.equal(contract.write, false);
  assert.equal(contract.operator, false);

  const rootId = randomUUID();
  assert.deepEqual(contract.input.parse({ id: rootId }), {
    id: rootId,
    depth: 2,
    maxNodes: 50,
    includeDeleted: false,
  });

  assert.deepEqual(
    contract.input.parse({ id: rootId, depth: 3, maxNodes: 100, includeDeleted: true }),
    {
      id: rootId,
      depth: 3,
      maxNodes: 100,
      includeDeleted: true,
    },
  );

  assert.throws(() => contract.input.parse({ id: rootId, depth: 0 }));
  assert.throws(() => contract.input.parse({ id: rootId, depth: 4 }));
  assert.throws(() => contract.input.parse({ id: rootId, maxNodes: 0 }));
  assert.throws(() => contract.input.parse({ id: rootId, maxNodes: 101 }));
  assert.throws(() => contract.input.parse({ id: rootId, extra: true }));

  const owner = {
    id: randomUUID(),
    ownerId: randomUUID(),
    scopeId: null,
    role: 'owner',
    permissions: [],
  };
  const foundationReader = {
    id: randomUUID(),
    ownerId: owner.ownerId,
    scopeId: null,
    role: 'agent',
    permissions: ['foundation:read'],
  };
  const workOnlyAgent = {
    id: randomUUID(),
    ownerId: owner.ownerId,
    scopeId: null,
    role: 'agent',
    permissions: ['work:read', 'work:write'],
  };
  assert.equal(allowed(owner, 'links.graph'), true);
  assert.equal(allowed(foundationReader, 'links.graph'), true);
  assert.equal(allowed(workOnlyAgent, 'links.graph'), false);
});

test('buildBoundedLinksGraph traverses outgoing and incoming links up to depth 1..3 and bounds maxNodes', () => {
  const a = '00000000-0000-4000-8000-000000000001';
  const b = '00000000-0000-4000-8000-000000000002';
  const c = '00000000-0000-4000-8000-000000000003';
  const d = '00000000-0000-4000-8000-000000000004';
  const e = '00000000-0000-4000-8000-000000000005';
  const deletedNode = '00000000-0000-4000-8000-000000000006';

  const entities = [
    { id: a, type: 'projects.project', deleted_at: null },
    { id: b, type: 'planning.task', deleted_at: null },
    { id: c, type: 'work.item', deleted_at: null },
    { id: d, type: 'context.note', deleted_at: null },
    { id: e, type: 'context.note', deleted_at: null },
    { id: deletedNode, type: 'context.note', deleted_at: '2026-11-19T00:00:00.000Z' },
  ];

  // Chain: b -> a (incoming to a), c -> b (incoming to b), c -> d (outgoing), d -> e, a -> deletedNode
  const links = [
    { source_id: b, target_id: a, relation: 'belongs_to' },
    { source_id: c, target_id: b, relation: 'implements' },
    { source_id: c, target_id: d, relation: 'uses_context' },
    { source_id: d, target_id: e, relation: 'references' },
    { source_id: a, target_id: deletedNode, relation: 'has_note' },
    // Add a cycle edge d -> a to confirm BFS terminates cleanly without duplicates
    { source_id: d, target_id: c, relation: 'back_ref' },
  ];

  const depth1 = buildBoundedLinksGraph(entities, links, {
    id: a,
    depth: 1,
    maxNodes: 50,
    includeDeleted: false,
  });
  assert.ok(depth1);
  assert.equal(depth1.rootId, a);
  assert.equal(depth1.depth, 1);
  assert.equal(depth1.truncated, false);
  assert.deepEqual(
    depth1.nodes.map((n) => [n.id, n.depth]),
    [
      [a, 0],
      [b, 1],
    ],
  );
  assert.deepEqual(depth1.edges, [{ sourceId: b, targetId: a, relation: 'belongs_to' }]);

  const depth2 = buildBoundedLinksGraph(entities, links, {
    id: a,
    depth: 2,
    maxNodes: 50,
    includeDeleted: false,
  });
  assert.ok(depth2);
  assert.equal(depth2.truncated, false);
  assert.deepEqual(
    depth2.nodes.map((n) => [n.id, n.depth]),
    [
      [a, 0],
      [b, 1],
      [c, 2],
    ],
  );

  const depth3 = buildBoundedLinksGraph(entities, links, {
    id: a,
    depth: 3,
    maxNodes: 50,
    includeDeleted: false,
  });
  assert.ok(depth3);
  assert.equal(depth3.truncated, false);
  assert.deepEqual(
    depth3.nodes.map((n) => [n.id, n.depth]),
    [
      [a, 0],
      [b, 1],
      [c, 2],
      [d, 3],
    ],
  );
  assert.equal(
    depth3.nodes.some((n) => n.id === e),
    false,
    'Depth 4 node must not be included at depth 3',
  );

  // maxNodes truncation stops cleanly and excludes dangling edges
  const truncated = buildBoundedLinksGraph(entities, links, {
    id: a,
    depth: 3,
    maxNodes: 2,
    includeDeleted: false,
  });
  assert.ok(truncated);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.nodes.length, 2);
  assert.deepEqual(truncated.edges, [{ sourceId: b, targetId: a, relation: 'belongs_to' }]);

  // includeDeleted: true exposes deleted neighbors with deleted: true
  const withDeleted = buildBoundedLinksGraph(entities, links, {
    id: a,
    depth: 1,
    maxNodes: 50,
    includeDeleted: true,
  });
  assert.ok(withDeleted);
  assert.equal(withDeleted.nodes.find((n) => n.id === deletedNode)?.deleted, true);
  assert.equal(
    buildBoundedLinksGraph(entities, links, {
      id: deletedNode,
      depth: 1,
      maxNodes: 50,
      includeDeleted: false,
    }),
    null,
  );
});

test('summarizeTaskWork aggregates work statuses cleanly and excludes deleted items', () => {
  assert.deepEqual(emptyTaskWorkSummary(), {
    total: 0,
    done: 0,
    active: 0,
    ready: 0,
    needsReview: 0,
    blocked: 0,
    failed: 0,
  });

  assert.deepEqual(
    summarizeTaskWork([
      { status: 'queued' },
      { status: 'queued' },
      { status: 'claimed' },
      { status: 'running' },
      { status: 'needs_review' },
      { status: 'blocked' },
      { status: 'failed' },
      { status: 'done' },
      { status: 'cancelled' },
      { status: 'done', deleted: true },
    ]),
    {
      total: 9,
      done: 1,
      active: 2,
      ready: 2,
      needsReview: 1,
      blocked: 1,
      failed: 1,
    },
  );
});

test('domain event parsing and owner/scope visibility checks fail closed', () => {
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const scope1 = randomUUID();
  const scope2 = randomUUID();

  assert.equal(parseDomainEventPayload(undefined), null);
  assert.equal(parseDomainEventPayload('not-json'), null);
  assert.equal(parseDomainEventPayload(JSON.stringify({ module: 'work' })), null);

  const parsed = parseDomainEventPayload(
    JSON.stringify({
      operation: 'work.create',
      module: 'work',
      ownerId: ownerA,
      scopeId: null,
      timestamp: '2026-11-19T22:00:00.000Z',
    }),
  );
  assert.deepEqual(parsed, {
    operation: 'work.create',
    module: 'work',
    ownerId: ownerA,
    scopeId: null,
    timestamp: '2026-11-19T22:00:00.000Z',
  });

  // Personal event visible only to same owner's personal scope
  assert.equal(isDomainEventVisibleToPrincipal(parsed, { ownerId: ownerA, scopeId: null }), true);
  assert.equal(
    isDomainEventVisibleToPrincipal(parsed, { ownerId: ownerA, scopeId: scope1 }),
    false,
  );
  assert.equal(isDomainEventVisibleToPrincipal(parsed, { ownerId: ownerB, scopeId: null }), false);

  // Scoped event visible only to same owner + same scope
  const scopedEv = { ownerId: ownerA, scopeId: scope1 };
  assert.equal(
    isDomainEventVisibleToPrincipal(scopedEv, { ownerId: ownerA, scopeId: scope1 }),
    true,
  );
  assert.equal(
    isDomainEventVisibleToPrincipal(scopedEv, { ownerId: ownerA, scopeId: null }),
    false,
  );
  assert.equal(
    isDomainEventVisibleToPrincipal(scopedEv, { ownerId: ownerA, scopeId: scope2 }),
    false,
  );
  assert.equal(
    isDomainEventVisibleToPrincipal(scopedEv, { ownerId: ownerB, scopeId: scope1 }),
    false,
  );

  // Missing ownerId always fails closed
  assert.equal(
    isDomainEventVisibleToPrincipal(
      { ownerId: null, scopeId: null },
      { ownerId: ownerA, scopeId: null },
    ),
    false,
  );
});
