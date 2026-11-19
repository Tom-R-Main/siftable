import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkGraph } from '../packages/core/dist/index.js';

const unverified = {
  state: 'unverified',
  requiredCount: 1,
  passedRequiredCount: 0,
  failedRequiredCount: 0,
  steps: [],
};

const passed = {
  state: 'commands_passed',
  requiredCount: 1,
  passedRequiredCount: 1,
  failedRequiredCount: 0,
  steps: [],
};

function makeNode(overrides) {
  return {
    id: overrides.id,
    revision: 1,
    title: overrides.title ?? overrides.id,
    description: '',
    status: overrides.status ?? 'queued',
    plan_version: 1,
    summary: overrides.summary ?? null,
    claimable: overrides.claimable ?? false,
    deleted_at: null,
    created_at: overrides.created_at ?? '2026-11-19T12:00:00.000Z',
    coverage: overrides.coverage ?? unverified,
    links: [],
    artifactCount: overrides.artifactCount ?? 0,
  };
}

test('buildWorkGraph computes transitive unblocks, waiting ratios, and active frontier edges', () => {
  const nodes = [
    makeNode({ id: 'root', title: 'Map pattern matching', status: 'queued', claimable: false }),
    makeNode({ id: 'midA', title: 'Core semantics', status: 'queued', claimable: false }),
    makeNode({ id: 'midB', title: 'Bitmasks & mutability', status: 'queued', claimable: false }),
    makeNode({ id: 'leaf1', title: 'Recursive Case', status: 'queued', claimable: true }),
    makeNode({ id: 'leaf2', title: 'Bitmask codec', status: 'needs_review', claimable: false }),
    makeNode({
      id: 'leaf3',
      title: 'Already settled',
      status: 'done',
      claimable: false,
      coverage: passed,
    }),
  ];
  const edges = [
    { work_id: 'root', predecessor_id: 'midA', gate: 'done', satisfied: false },
    { work_id: 'root', predecessor_id: 'midB', gate: 'done', satisfied: false },
    { work_id: 'midA', predecessor_id: 'leaf1', gate: 'done', satisfied: false },
    { work_id: 'midB', predecessor_id: 'leaf2', gate: 'done', satisfied: false },
    { work_id: 'midB', predecessor_id: 'leaf3', gate: 'done', satisfied: true },
  ];

  const graph = buildWorkGraph(nodes, edges);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  assert.equal(byId.get('root').isRoot, true);
  assert.equal(byId.get('root').depth, 0);
  assert.deepEqual(byId.get('root').waiting, { satisfied: 0, total: 2 });
  assert.equal(byId.get('root').unblocksCount, 0);

  assert.equal(byId.get('midB').depth, 1);
  assert.deepEqual(byId.get('midB').waiting, { satisfied: 1, total: 2 });
  assert.equal(byId.get('midB').unblocksCount, 1);

  assert.equal(byId.get('leaf1').uiState, 'ready');
  assert.equal(byId.get('leaf1').kind, 'leaf');
  assert.equal(byId.get('leaf1').depth, 2);
  assert.equal(byId.get('leaf1').unblocksCount, 2);

  assert.equal(byId.get('leaf2').uiState, 'needs_you');
  assert.equal(byId.get('leaf2').unblocksCount, 2);

  assert.equal(byId.get('leaf3').uiState, 'done');
  assert.equal(byId.get('leaf3').unblocksCount, 0);

  // Next queue prioritizes needs_you ahead of ready when unblocksCount ties.
  assert.deepEqual(graph.next, ['leaf2', 'leaf1']);
  assert.equal(graph.counts.next, 2);
  assert.equal(graph.counts.needsYou, 1);
  assert.equal(graph.counts.ready, 1);
  assert.equal(graph.counts.done, 1);

  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
  assert.equal(edgeById.get('leaf1->midA').active, true);
  assert.equal(edgeById.get('leaf2->midB').active, true);
  assert.equal(edgeById.get('leaf3->midB').active, false);
  assert.equal(edgeById.get('midA->root').active, false);
});

test('buildWorkGraph deduplicates diamond unblocks and filters cleanly by rootId', () => {
  const nodes = [
    makeNode({ id: 'root1', title: 'Root 1' }),
    makeNode({ id: 'root2', title: 'Root 2' }),
    makeNode({ id: 'left', title: 'Left branch' }),
    makeNode({ id: 'right', title: 'Right branch' }),
    makeNode({ id: 'shared', title: 'Shared leaf', claimable: true }),
    makeNode({ id: 'other', title: 'Other leaf', claimable: true }),
  ];
  const edges = [
    { work_id: 'root1', predecessor_id: 'left', gate: 'done', satisfied: false },
    { work_id: 'root1', predecessor_id: 'right', gate: 'done', satisfied: false },
    { work_id: 'left', predecessor_id: 'shared', gate: 'done', satisfied: false },
    { work_id: 'right', predecessor_id: 'shared', gate: 'done', satisfied: false },
    { work_id: 'root2', predecessor_id: 'other', gate: 'done', satisfied: false },
  ];

  const full = buildWorkGraph(nodes, edges);
  const shared = full.nodes.find((n) => n.id === 'shared');
  // Unblocks left, right, and root1 (3 distinct nodes, not 4).
  assert.equal(shared.directUnblocksCount, 2);
  assert.equal(shared.unblocksCount, 3);
  assert.equal(full.roots.length, 2);

  const filtered = buildWorkGraph(nodes, edges, { rootId: 'root1' });
  assert.deepEqual(filtered.nodes.map((n) => n.id).sort(), ['left', 'right', 'root1', 'shared']);
  // Root selector still retains all roots across scope.
  assert.equal(filtered.roots.length, 2);
});
