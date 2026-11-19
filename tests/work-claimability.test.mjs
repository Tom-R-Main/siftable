import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operations, SiftError } from '../packages/contracts/dist/index.js';
import {
  buildWorkGraph,
  dependencyCycleError,
  deriveAgentWorkClaimability,
  deriveWorkClaimability,
  invalidTransitionError,
  notClaimableError,
  revisionConflictError,
  staleLeaseError,
  toPublicClaimability,
} from '../packages/core/dist/index.js';
import { SiftClient } from '../packages/client/dist/index.js';

const NOW = Date.parse('2026-11-19T22:00:00.000Z');
const FUTURE = '2026-11-19T22:10:00.000Z';
const PAST = '2026-11-19T21:55:00.000Z';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const claimIdOf = (secret) => sha256(`siftable-lease:${sha256(secret)}`);

test('deriveWorkClaimability accurately covers all 8 states and blockedBy diagnostics', () => {
  assert.equal(deriveAgentWorkClaimability, deriveWorkClaimability);

  // 1. ready (queued, no deps & queued with all satisfied deps)
  const readyEmpty = deriveWorkClaimability([], { status: 'queued', nowMs: NOW });
  assert.equal(readyEmpty.claimable, true);
  assert.equal(readyEmpty.state, 'ready');
  assert.equal(readyEmpty.nextAction, 'work.claim');
  assert.deepEqual(readyEmpty.blockedBy, []);

  const readySatisfied = deriveWorkClaimability(
    [
      {
        workId: 'dep-1',
        title: 'Upstream done',
        status: 'done',
        gate: 'done',
        satisfied: true,
      },
    ],
    { status: 'queued', nowMs: NOW },
  );
  assert.equal(readySatisfied.claimable, true);
  assert.equal(readySatisfied.state, 'ready');
  assert.deepEqual(readySatisfied.blockedBy, []);

  // 2. waiting (unmet done and commands_passed predecessors)
  const waiting = deriveWorkClaimability(
    [
      {
        workId: 'dep-done',
        title: 'Done predecessor',
        status: 'done',
        gate: 'done',
        satisfied: true,
      },
      {
        workId: 'dep-running',
        title: 'Running predecessor',
        status: 'running',
        gate: 'done',
        satisfied: false,
      },
      {
        workId: 'dep-cmd',
        title: 'Verification gate predecessor',
        status: 'queued',
        gate: 'commands_passed',
        satisfied: false,
        coverageState: 'unverified',
      },
    ],
    { status: 'queued', nowMs: NOW },
  );
  assert.equal(waiting.claimable, false);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.nextAction, 'wait_for_dependencies');
  assert.equal(waiting.blockedBy.length, 2);
  assert.deepEqual(
    waiting.blockedBy.map((b) => ({
      workId: b.workId,
      title: b.title,
      status: b.status,
      gate: b.gate,
    })),
    [
      { workId: 'dep-running', title: 'Running predecessor', status: 'running', gate: 'done' },
      {
        workId: 'dep-cmd',
        title: 'Verification gate predecessor',
        status: 'queued',
        gate: 'commands_passed',
      },
    ],
  );
  assert.match(waiting.blockedBy[0].reason, /waiting for status "done"/);
  assert.match(waiting.blockedBy[1].reason, /waiting for verification state "commands_passed"/);

  // 3. dependency_failed (failed, cancelled, or deleted predecessor wins over waiting)
  const depFailed = deriveWorkClaimability(
    [
      {
        workId: 'dep-wait',
        title: 'Still queued',
        status: 'queued',
        gate: 'done',
        satisfied: false,
      },
      {
        workId: 'dep-fail',
        title: 'Failed upstream',
        status: 'failed',
        gate: 'done',
        satisfied: false,
      },
      {
        workId: 'dep-deleted',
        title: 'Deleted upstream',
        status: 'done',
        gate: 'done',
        satisfied: false,
        deleted: true,
      },
    ],
    { status: 'queued', nowMs: NOW },
  );
  assert.equal(depFailed.claimable, false);
  assert.equal(depFailed.state, 'dependency_failed');
  assert.equal(depFailed.nextAction, 'unblock_or_requeue_predecessor');
  assert.equal(depFailed.blockedBy.length, 3);
  assert.equal(depFailed.blockedBy[1].status, 'failed');
  assert.match(depFailed.blockedBy[1].reason, /failed/i);
  assert.equal(depFailed.blockedBy[2].status, 'deleted');
  assert.match(depFailed.blockedBy[2].reason, /deleted/i);

  // 4. leased (claimed or running with active unexpired lease, or missing expiry)
  const leased = deriveWorkClaimability([], {
    status: 'running',
    expiresAt: FUTURE,
    nowMs: NOW,
  });
  assert.equal(leased.claimable, false);
  assert.equal(leased.state, 'leased');
  assert.equal(leased.nextAction, 'wait_for_lease_or_reclaim');
  assert.deepEqual(leased.blockedBy, []);
  assert.match(leased.reason, /2026-11-19T22:10:00\.000Z/);

  const leasedNoExpiry = deriveWorkClaimability([], {
    status: 'claimed',
    expiresAt: null,
    nowMs: NOW,
  });
  assert.equal(leasedNoExpiry.claimable, false);
  assert.equal(leasedNoExpiry.state, 'leased');
  assert.deepEqual(leasedNoExpiry.blockedBy, []);

  // 5. lease_expired (claimed/running with expiresAt <= nowMs and ready deps)
  const expired = deriveWorkClaimability([], {
    status: 'claimed',
    expiresAt: PAST,
    nowMs: NOW,
  });
  assert.equal(expired.claimable, true);
  assert.equal(expired.state, 'lease_expired');
  assert.equal(expired.nextAction, 'work.claim');
  assert.deepEqual(expired.blockedBy, []);
  assert.match(expired.reason, /2026-11-19T21:55:00\.000Z/);

  // Expired lease with unmet dependencies must NOT be claimable.
  const expiredWaiting = deriveWorkClaimability(
    [{ workId: 'dep-x', status: 'queued', gate: 'done', satisfied: false }],
    { status: 'running', expiresAt: PAST, nowMs: NOW },
  );
  assert.equal(expiredWaiting.claimable, false);
  assert.equal(expiredWaiting.state, 'waiting');
  assert.equal(expiredWaiting.blockedBy.length, 1);

  // 6. blocked
  const blocked = deriveWorkClaimability([], {
    status: 'blocked',
    summary: 'Waiting for API key decision',
    nowMs: NOW,
  });
  assert.equal(blocked.claimable, false);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.nextAction, 'work.requeue');
  assert.deepEqual(blocked.blockedBy, []);
  assert.match(blocked.reason, /Waiting for API key decision/);

  // 7. in_review
  const inReview = deriveWorkClaimability([], { status: 'needs_review', nowMs: NOW });
  assert.equal(inReview.claimable, false);
  assert.equal(inReview.state, 'in_review');
  assert.equal(inReview.nextAction, 'work.review_or_accept');
  assert.deepEqual(inReview.blockedBy, []);

  // 8. terminal (done, failed, cancelled, deleted)
  for (const status of ['done', 'failed', 'cancelled']) {
    const term = deriveWorkClaimability([], { status, nowMs: NOW });
    assert.equal(term.claimable, false);
    assert.equal(term.state, 'terminal');
    assert.equal(term.nextAction, 'none');
    assert.deepEqual(term.blockedBy, []);
  }
  const deleted = deriveWorkClaimability([], { status: 'queued', deleted: true, nowMs: NOW });
  assert.equal(deleted.claimable, false);
  assert.equal(deleted.state, 'terminal');
  assert.equal(deleted.nextAction, 'none');
  assert.deepEqual(deleted.blockedBy, []);
});

test('buildWorkGraph attaches claimability diagnostics alongside claimable boolean', () => {
  const unverified = {
    state: 'unverified',
    requiredCount: 1,
    passedRequiredCount: 0,
    failedRequiredCount: 0,
    steps: [],
  };
  const makeNode = (overrides) => ({
    id: overrides.id,
    revision: 1,
    title: overrides.title ?? overrides.id,
    description: '',
    status: overrides.status ?? 'queued',
    plan_version: 1,
    summary: overrides.summary ?? null,
    claimable: overrides.claimable ?? false,
    expires_at: overrides.expires_at,
    deleted_at: null,
    created_at: '2026-11-19T12:00:00.000Z',
    coverage: unverified,
    links: [],
    artifactCount: 0,
  });

  const graph = buildWorkGraph(
    [
      makeNode({ id: 'parent-wait', title: 'Waiting parent', status: 'queued', claimable: false }),
      makeNode({
        id: 'parent-fail',
        title: 'Dep failed parent',
        status: 'queued',
        claimable: false,
      }),
      makeNode({ id: 'child-ready', title: 'Ready leaf', status: 'queued', claimable: true }),
      makeNode({ id: 'child-failed', title: 'Failed leaf', status: 'failed', claimable: false }),
      makeNode({
        id: 'expired-node',
        title: 'Expired lease node',
        status: 'running',
        claimable: true,
        expires_at: PAST,
      }),
      makeNode({
        id: 'review-node',
        title: 'Needs review node',
        status: 'needs_review',
        claimable: false,
      }),
    ],
    [
      { work_id: 'parent-wait', predecessor_id: 'child-ready', gate: 'done', satisfied: false },
      { work_id: 'parent-fail', predecessor_id: 'child-failed', gate: 'done', satisfied: false },
    ],
  );

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('parent-wait').claimable, false);
  assert.equal(byId.get('parent-wait').claimability.state, 'waiting');
  assert.equal(byId.get('parent-wait').claimability.blockedBy[0].workId, 'child-ready');

  assert.equal(byId.get('parent-fail').claimable, false);
  assert.equal(byId.get('parent-fail').claimability.state, 'dependency_failed');
  assert.equal(byId.get('parent-fail').claimability.nextAction, 'unblock_or_requeue_predecessor');
  assert.equal(byId.get('parent-fail').claimability.blockedBy[0].workId, 'child-failed');

  assert.equal(byId.get('child-ready').claimable, true);
  assert.equal(byId.get('child-ready').claimability.state, 'ready');
  assert.deepEqual(byId.get('child-ready').claimability.blockedBy, []);

  assert.equal(byId.get('child-failed').claimable, false);
  assert.equal(byId.get('child-failed').claimability.state, 'terminal');

  assert.equal(byId.get('expired-node').claimable, true);
  assert.equal(byId.get('expired-node').claimability.state, 'lease_expired');

  assert.equal(byId.get('review-node').claimable, false);
  assert.equal(byId.get('review-node').claimability.state, 'in_review');
});

test('structured 409 error helpers populate actionable suggestions and secret-free details', () => {
  const depFailed = toPublicClaimability(
    deriveWorkClaimability(
      [
        {
          workId: 'pred-1',
          title: 'Broken build',
          status: 'failed',
          gate: 'done',
          satisfied: false,
        },
      ],
      { status: 'queued', nowMs: NOW },
    ),
  );
  const claimErr = notClaimableError({
    workId: 'work-1',
    status: 'queued',
    revision: 3,
    claimability: depFailed,
  });
  assert.ok(claimErr instanceof SiftError);
  assert.equal(claimErr.status, 409);
  assert.equal(claimErr.code, 'not_claimable');
  assert.ok(claimErr.suggestions && claimErr.suggestions.length > 0);
  assert.deepEqual(claimErr.details?.unmetPredecessorIds, ['pred-1']);
  assert.equal(claimErr.details?.claimability?.state, 'dependency_failed');

  const revErr = revisionConflictError({
    workId: 'work-1',
    operation: 'work.update',
    expectedRevision: 2,
    actualRevision: 5,
    status: 'queued',
  });
  assert.equal(revErr.status, 409);
  assert.equal(revErr.code, 'revision_conflict');
  assert.equal(revErr.details?.expectedRevision, 2);
  assert.equal(revErr.details?.actualRevision, 5);
  assert.ok(revErr.suggestions && revErr.suggestions.length > 0);

  const leaseErr = staleLeaseError({
    workId: 'work-1',
    status: 'running',
    revision: 4,
    currentEpoch: 2,
    providedEpoch: 1,
    expiresAt: PAST,
    leaseExpired: true,
  });
  assert.equal(leaseErr.status, 409);
  assert.equal(leaseErr.code, 'stale_lease');
  assert.equal(leaseErr.details?.currentEpoch, 2);
  assert.equal(leaseErr.details?.providedEpoch, 1);
  assert.equal(leaseErr.details?.leaseExpired, true);
  assert.match(leaseErr.suggestions?.[0] ?? '', /expired/i);
  assert.equal('claimSecret' in (leaseErr.details ?? {}), false);

  const transErr = invalidTransitionError({
    workId: 'work-1',
    operation: 'work.fork',
    status: 'needs_review',
    revision: 4,
    message: 'Fork only queued, blocked, failed, or actively leased work',
  });
  assert.equal(transErr.status, 409);
  assert.equal(transErr.code, 'invalid_transition');
  assert.ok(transErr.suggestions && transErr.suggestions.length > 0);

  const cycleErr = dependencyCycleError({ workId: 'work-1', predecessorId: 'work-2' });
  assert.equal(cycleErr.status, 409);
  assert.equal(cycleErr.code, 'dependency_cycle');
  assert.equal(cycleErr.details?.predecessorId, 'work-2');
});

test('work.fork contract accepts optional lease fields and SiftClient attaches local lease custody automatically', async () => {
  const workId = randomUUID();
  const baseForkInput = {
    id: workId,
    revision: 2,
    reason: 'Split active work into sub-branches',
    branches: [{ title: 'Sub-branch A' }],
  };
  assert.doesNotThrow(() => operations['work.fork'].input.parse(baseForkInput));
  assert.doesNotThrow(() =>
    operations['work.fork'].input.parse({
      ...baseForkInput,
      claimSecret: 'a'.repeat(40),
      epoch: 1,
    }),
  );

  // Spin up an in-memory loopback API stub to verify SiftClient active-lease injection,
  // idempotent replay after lease release, unleased fallback, and 409 error details round-trip.
  const leases = new Map();
  const receipts = new Map();
  const seenForkBodies = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const idemKey = req.headers['idempotency-key'];
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.url === '/v1/operations/work.claim') {
      const existing = leases.get(body.id);
      const epoch = existing ? existing.epoch + 1 : 1;
      leases.set(body.id, { claimSecret: body.claimSecret, epoch });
      return send(200, { data: { id: body.id, status: 'claimed', epoch } });
    }
    if (req.url === '/v1/operations/work.lease') {
      const current = leases.get(body.id);
      if (!current) {
        return send(409, {
          error: {
            code: 'stale_lease',
            message: 'An active lease owned by this principal is required',
          },
        });
      }
      return send(200, {
        data: { epoch: current.epoch, claimId: claimIdOf(current.claimSecret) },
      });
    }
    if (req.url === '/v1/operations/work.fork') {
      seenForkBodies.push(body);
      if (typeof idemKey === 'string' && receipts.has(idemKey)) {
        const cached = receipts.get(idemKey);
        if (cached.claimSecret !== body.claimSecret || cached.epoch !== body.epoch) {
          return send(409, {
            error: {
              code: 'idempotency_conflict',
              message: 'Idempotency key was already used with different input',
            },
          });
        }
        return send(200, { data: cached.result });
      }
      const current = leases.get(body.id);
      if (current) {
        if (body.claimSecret !== current.claimSecret || body.epoch !== current.epoch) {
          return send(409, {
            error: {
              code: 'stale_lease',
              message: 'An active lease owned by this principal and epoch is required',
              suggestions: ['Only the active lease holder may fork leased work.'],
              details: { workId: body.id, currentEpoch: current.epoch },
            },
          });
        }
        // Atomically release active lease.
        leases.delete(body.id);
      }
      const result = {
        parent: { id: body.id, status: 'queued', releasedLease: Boolean(current) },
        branches: [{ id: randomUUID(), title: body.branches[0].title }],
      };
      if (typeof idemKey === 'string') {
        receipts.set(idemKey, { claimSecret: body.claimSecret, epoch: body.epoch, result });
      }
      return send(200, { data: result });
    }
    return send(404, { error: { code: 'not_found', message: `Unexpected ${req.url}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'sift-claimability-client-'));
  try {
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    const credPath = join(root, 'worker.json');
    await writeFile(
      credPath,
      JSON.stringify({
        apiUrl,
        token: 'test-only-opaque-token-0123456789abcdef',
        principalId: randomUUID(),
        ownerId: randomUUID(),
        scopeId: null,
      }),
      { mode: 0o600 },
    );
    const leaseDir = join(root, 'leases');
    await mkdir(leaseDir, { mode: 0o700 });
    const client = await SiftClient.fromFile(credPath, leaseDir);

    // 1. Active lease holder invokes work.fork without passing claimSecret/epoch -> client injects them!
    await client.invoke('work.claim', { id: workId }, 'claim-active-1');
    const forked = await client.invoke('work.fork', baseForkInput, 'fork-active-1');
    assert.equal(forked.parent.releasedLease, true);
    assert.equal(typeof seenForkBodies[0].claimSecret, 'string');
    assert.equal(seenForkBodies[0].epoch, 1);

    // 2. Idempotent retry with same requestKey after lease release replays the bound claimSecret/epoch!
    const replayed = await client.invoke('work.fork', baseForkInput, 'fork-active-1');
    assert.deepEqual(replayed, forked);
    assert.equal(seenForkBodies[1].claimSecret, seenForkBodies[0].claimSecret);
    assert.equal(seenForkBodies[1].epoch, 1);

    // 3. Unleased work.fork falls back cleanly without claimSecret/epoch.
    const unleasedId = randomUUID();
    const unleased = await client.invoke(
      'work.fork',
      { ...baseForkInput, id: unleasedId },
      'fork-unleased-1',
    );
    assert.equal(unleased.parent.releasedLease, false);
    assert.equal(seenForkBodies[2].claimSecret, undefined);
    assert.equal(seenForkBodies[2].epoch, undefined);

    // 4. Structured 409 suggestions & details survive HTTP -> SiftClient -> SiftError.
    const otherWorkId = randomUUID();
    leases.set(otherWorkId, { claimSecret: 'b'.repeat(40), epoch: 3 });
    await assert.rejects(
      () => client.invoke('work.fork', { ...baseForkInput, id: otherWorkId }, 'fork-non-holder-1'),
      (err) => {
        assert.ok(err instanceof SiftError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'stale_lease');
        assert.deepEqual(err.suggestions, ['Only the active lease holder may fork leased work.']);
        assert.deepEqual(err.details, { workId: otherWorkId, currentEpoch: 3 });
        return true;
      },
    );
  } finally {
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
