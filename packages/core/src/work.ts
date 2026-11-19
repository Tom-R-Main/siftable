import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { operations, canonical, type Operation, type Principal } from '@siftable/contracts';
import { setDeleted } from './lifecycle.js';
import { digest } from './database.js';
import { agentWorkClaimTokenDigest } from './claimDigest.js';
import { deriveVerificationCoverage } from './verificationCoverage.js';
import type { VerificationStep } from './verificationTypes.js';
import { buildWorkGraph, type WorkPriority } from './workGraph.js';
import { redactSecretsInPayload } from './readSanitizer.js';
import {
  dependencyCycleError,
  deriveWorkClaimability,
  invalidTransitionError,
  notClaimableError,
  revisionConflictError,
  staleLeaseError,
  toPublicClaimability,
  type DerivedWorkClaimability,
  type WorkDependencyStateInput,
} from './claimability.js';
import { entity, reference, link, first, fail } from './helpers.js';

export type WorkUpdateField = 'title' | 'description' | 'steps' | 'rank' | 'priority' | 'labels';

export interface WorkUpdateStep {
  key: string;
  title: string;
  required: boolean;
}

export interface WorkUpdateDiffInput {
  title: string;
  description: string;
  steps: WorkUpdateStep[];
  rank: number;
  priority: WorkPriority;
  labels: string[];
}

export interface WorkUpdatePatch {
  title?: string;
  description?: string;
  steps?: WorkUpdateStep[];
  rank?: number;
  priority?: WorkPriority;
  labels?: string[];
}

export interface WorkUpdateDiff {
  changedFields: WorkUpdateField[];
  before: Partial<WorkUpdateDiffInput>;
  after: Partial<WorkUpdateDiffInput>;
  invalidatedEvidence: boolean;
}

function normalizeSteps(
  steps: readonly { key: string; title: string; required: boolean }[],
): WorkUpdateStep[] {
  return steps.map((s) => ({ key: s.key, title: s.title, required: s.required }));
}

export function computeWorkUpdateDiff(
  current: WorkUpdateDiffInput,
  patch: WorkUpdatePatch,
): WorkUpdateDiff {
  const changedFields: WorkUpdateField[] = [];
  const before: Partial<WorkUpdateDiffInput> = {};
  const after: Partial<WorkUpdateDiffInput> = {};
  let invalidatedEvidence = false;

  if (patch.title !== undefined && patch.title !== current.title) {
    changedFields.push('title');
    before.title = current.title;
    after.title = patch.title;
    invalidatedEvidence = true;
  }
  if (patch.description !== undefined && patch.description !== current.description) {
    changedFields.push('description');
    before.description = current.description;
    after.description = patch.description;
    invalidatedEvidence = true;
  }
  if (patch.steps !== undefined) {
    const currentSteps = normalizeSteps(current.steps);
    const nextSteps = normalizeSteps(patch.steps);
    if (canonical(currentSteps) !== canonical(nextSteps)) {
      changedFields.push('steps');
      before.steps = currentSteps;
      after.steps = nextSteps;
      invalidatedEvidence = true;
    }
  }
  if (patch.rank !== undefined && patch.rank !== current.rank) {
    changedFields.push('rank');
    before.rank = current.rank;
    after.rank = patch.rank;
  }
  if (patch.priority !== undefined && patch.priority !== current.priority) {
    changedFields.push('priority');
    before.priority = current.priority;
    after.priority = patch.priority;
  }
  if (patch.labels !== undefined) {
    const same =
      current.labels.length === patch.labels.length &&
      current.labels.every((label, index) => label === patch.labels![index]);
    if (!same) {
      changedFields.push('labels');
      before.labels = [...current.labels];
      after.labels = [...patch.labels];
    }
  }

  return {
    changedFields,
    before: redactSecretsInPayload(before),
    after: redactSecretsInPayload(after),
    invalidatedEvidence,
  };
}

interface WorkRow {
  id: string;
  revision: number;
  deleted_at: Date | null;
  title: string;
  description: string;
  rank: number;
  priority: WorkPriority;
  labels: string[];
  status: string;
  epoch: number;
  claim_principal: string | null;
  claim_digest: string | null;
  expires_at: Date | null;
  plan_version: number;
  summary: string | null;
  accepted_by: string | null;
  accepted_plan_version: number | null;
  created_at: Date;
}
async function item(c: PoolClient, id: string): Promise<WorkRow> {
  return first(
    (
      await c.query<WorkRow>(
        'SELECT w.*,e.deleted_at FROM work.items w JOIN foundation.entities e USING(id) WHERE w.id=$1 FOR UPDATE OF w',
        [id],
      )
    ).rows,
  );
}
async function event(
  c: PoolClient,
  p: Principal,
  id: string,
  name: string,
  detail: unknown,
): Promise<void> {
  await c.query(
    'INSERT INTO work.events(owner_id,scope_id,work_id,actor,event,detail) VALUES($1,$2,$3,$4,$5,$6)',
    [p.ownerId, p.scopeId, id, p.id, name, JSON.stringify(detail)],
  );
}
async function plan(
  c: PoolClient,
  p: Principal,
  id: string,
  version: number,
  steps: { key: string; title: string; required: boolean }[],
  reason: string,
): Promise<void> {
  if (new Set(steps.map((x) => x.key)).size !== steps.length)
    fail(400, 'duplicate_step', 'Verification step keys must be unique');
  await c.query(
    'INSERT INTO work.plans(id,owner_id,scope_id,work_id,version,steps,reason,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      randomUUID(),
      p.ownerId,
      p.scopeId,
      id,
      version,
      JSON.stringify(steps.map((x) => ({ ...x, id: randomUUID() }))),
      reason,
      p.id,
    ],
  );
}
async function coverage(c: PoolClient, w: WorkRow) {
  const pl = first(
    (
      await c.query<{ steps: VerificationStep[]; version: number }>(
        'SELECT steps,version FROM work.plans WHERE work_id=$1 AND version=$2',
        [w.id, w.plan_version],
      )
    ).rows,
  );
  const evidence = await c.query<{
    step_id: string;
    outcome: 'passed' | 'failed' | 'error';
    created_at: Date;
    sequence: string;
  }>('SELECT * FROM work.evidence WHERE work_id=$1 AND plan_version=$2 ORDER BY sequence', [
    w.id,
    w.plan_version,
  ]);
  return {
    plan: pl,
    coverage: deriveVerificationCoverage(
      pl.steps,
      evidence.rows.map((e) => ({
        stepId: e.step_id,
        outcome: e.outcome,
        ranAt: e.created_at.toISOString(),
        createdAt: e.created_at.toISOString(),
        sequence: Number(e.sequence),
      })),
    ),
  };
}
async function evaluateClaimability(c: PoolClient, w: WorkRow): Promise<DerivedWorkClaimability> {
  const nowRow = first((await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows);
  const deps = await c.query<{ predecessor_id: string; gate: 'done' | 'commands_passed' }>(
    'SELECT predecessor_id,gate FROM work.dependencies WHERE work_id=$1 ORDER BY predecessor_id',
    [w.id],
  );
  const depInputs: WorkDependencyStateInput[] = [];
  for (const d of deps.rows) {
    const pred = await item(c, d.predecessor_id);
    let predCoverageState: string | undefined;
    if (!pred.deleted_at && d.gate === 'commands_passed') {
      predCoverageState = (await coverage(c, pred)).coverage.state;
    }
    const satisfied =
      !pred.deleted_at &&
      (d.gate === 'done' ? pred.status === 'done' : predCoverageState === 'commands_passed');
    depInputs.push({
      workId: pred.id,
      title: pred.title,
      status: pred.status,
      gate: d.gate,
      satisfied,
      deleted: pred.deleted_at !== null,
      coverageState: predCoverageState,
    });
  }
  return deriveWorkClaimability(depInputs, {
    status: w.status,
    deleted: w.deleted_at !== null,
    expiresAt: w.expires_at,
    summary: w.summary,
    nowMs: nowRow.now.getTime(),
  });
}
async function display(c: PoolClient, w: WorkRow) {
  const { claim_digest: _digest, claim_principal: _claim, ...publicFields } = w;
  const derived = await evaluateClaimability(c, w);
  return {
    ...publicFields,
    ...(await coverage(c, w)),
    claimable: derived.claimable,
    claimability: toPublicClaimability(derived),
    links: (
      await c.query('SELECT target_id,relation FROM foundation.links WHERE source_id=$1', [w.id])
    ).rows,
  };
}
async function assertLease(
  c: PoolClient,
  p: Principal,
  w: WorkRow,
  input: { claimSecret: string; epoch: number },
) {
  const valid = first(
    (
      await c.query<{ valid: boolean }>('SELECT $1::timestamptz > clock_timestamp() AS valid', [
        w.expires_at,
      ])
    ).rows,
  ).valid;
  if (
    !['claimed', 'running'].includes(w.status) ||
    w.claim_principal !== p.id ||
    w.epoch !== input.epoch ||
    w.claim_digest !== agentWorkClaimTokenDigest(input.claimSecret) ||
    !valid
  )
    throw staleLeaseError({
      workId: w.id,
      status: w.status,
      revision: w.revision,
      currentEpoch: w.epoch,
      providedEpoch: input.epoch,
      expiresAt: w.expires_at,
      leaseExpired: w.expires_at !== null ? !valid : undefined,
    });
}
export async function workOperation(
  c: PoolClient,
  p: Principal,
  name: Operation,
  input: unknown,
): Promise<unknown> {
  // Serialize scope-level work mutations to make dependency and claim checks atomic.
  // Reads share this bounded MVP lock to avoid lock-order inversions in dependency inspection.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `work:${p.ownerId}:${p.scopeId ?? 'personal'}`,
  ]);
  if (name === 'work.create') {
    const a = operations[name].input.parse(input);
    const id = await entity(c, p, 'work.item');
    for (const d of a.dependencies) await reference(c, d.id, 'work.item');
    await c.query(
      'INSERT INTO work.items(id,owner_id,scope_id,title,description,rank,priority,labels) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, p.ownerId, p.scopeId, a.title, a.description, a.rank, a.priority, a.labels],
    );
    await plan(c, p, id, 1, a.steps, 'Initial plan');
    for (const d of a.dependencies)
      await c.query(
        'INSERT INTO work.dependencies(owner_id,scope_id,work_id,predecessor_id,gate) VALUES($1,$2,$3,$4,$5)',
        [p.ownerId, p.scopeId, id, d.id, d.gate],
      );
    if (a.projectId) {
      await reference(c, a.projectId, 'projects.project');
      await link(c, p, id, a.projectId, 'belongs_to');
    }
    if (a.taskId) {
      await reference(c, a.taskId, 'planning.task');
      await link(c, p, id, a.taskId, 'implements');
    }
    for (const target of a.contextIds) {
      await reference(c, target, 'context.note');
      await link(c, p, id, target, 'uses_context');
    }
    await event(c, p, id, 'created', {});
    return display(c, await item(c, id));
  }
  if (name === 'work.list') {
    const a = operations[name].input.parse(input);
    const r = await c.query<WorkRow>(
      'SELECT w.*,e.deleted_at FROM work.items w JOIN foundation.entities e USING(id) WHERE ($3 OR e.deleted_at IS NULL) ORDER BY w.rank ASC,w.created_at ASC,w.id ASC LIMIT $1 OFFSET $2',
      [a.limit, a.offset, a.includeDeleted],
    );
    return Promise.all(r.rows.map((w) => display(c, w)));
  }
  if (name === 'work.graph') {
    const a = operations[name].input.parse(input);
    const itemsResult = a.projectId
      ? await c.query<WorkRow>(
          "SELECT w.*,e.deleted_at FROM work.items w JOIN foundation.entities e USING(id) JOIN foundation.links l ON l.source_id=w.id AND l.target_id=$1 AND l.relation='belongs_to' WHERE ($2 OR e.deleted_at IS NULL) ORDER BY w.created_at,w.id",
          [a.projectId, a.includeDeleted],
        )
      : await c.query<WorkRow>(
          'SELECT w.*,e.deleted_at FROM work.items w JOIN foundation.entities e USING(id) WHERE ($1 OR e.deleted_at IS NULL) ORDER BY w.created_at,w.id',
          [a.includeDeleted],
        );
    const rows = itemsResult.rows;
    if (rows.length === 0) return buildWorkGraph([], [], { rootId: a.rootId });

    const ids = rows.map((r) => r.id);
    const nowRow = first((await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows);
    const nowMs = nowRow.now.getTime();

    const depsRows = (
      await c.query<{ work_id: string; predecessor_id: string; gate: 'done' | 'commands_passed' }>(
        'SELECT work_id,predecessor_id,gate FROM work.dependencies WHERE work_id = ANY($1::uuid[]) ORDER BY work_id,predecessor_id',
        [ids],
      )
    ).rows;

    const rowById = new Map<string, WorkRow>();
    for (const r of rows) rowById.set(r.id, r);
    const externalPredIds = [
      ...new Set(depsRows.map((d) => d.predecessor_id).filter((pid) => !rowById.has(pid))),
    ];
    if (externalPredIds.length > 0) {
      const extRows = (
        await c.query<WorkRow>(
          'SELECT w.*,e.deleted_at FROM work.items w JOIN foundation.entities e USING(id) WHERE w.id = ANY($1::uuid[])',
          [externalPredIds],
        )
      ).rows;
      for (const r of extRows) rowById.set(r.id, r);
    }

    const allEvalIds = [...rowById.keys()];
    const planRows = (
      await c.query<{ work_id: string; version: number; steps: VerificationStep[] }>(
        'SELECT work_id,version,steps FROM work.plans WHERE work_id = ANY($1::uuid[])',
        [allEvalIds],
      )
    ).rows;
    const planByKey = new Map<string, VerificationStep[]>();
    for (const pl of planRows) planByKey.set(`${pl.work_id}:${pl.version}`, pl.steps);

    const evidenceRows = (
      await c.query<{
        work_id: string;
        plan_version: number;
        step_id: string;
        outcome: 'passed' | 'failed' | 'error';
        created_at: Date;
        sequence: string;
      }>(
        'SELECT work_id,plan_version,step_id,outcome,created_at,sequence FROM work.evidence WHERE work_id = ANY($1::uuid[]) ORDER BY sequence',
        [allEvalIds],
      )
    ).rows;
    const evidenceByKey = new Map<
      string,
      {
        stepId: string;
        outcome: 'passed' | 'failed' | 'error';
        ranAt: string;
        createdAt: string;
        sequence: number;
      }[]
    >();
    for (const ev of evidenceRows) {
      const k = `${ev.work_id}:${ev.plan_version}`;
      const list = evidenceByKey.get(k) ?? [];
      list.push({
        stepId: ev.step_id,
        outcome: ev.outcome,
        ranAt: ev.created_at.toISOString(),
        createdAt: ev.created_at.toISOString(),
        sequence: Number(ev.sequence),
      });
      evidenceByKey.set(k, list);
    }

    const coverageById = new Map<string, ReturnType<typeof deriveVerificationCoverage>>();
    for (const [id, r] of rowById.entries()) {
      const k = `${id}:${r.plan_version}`;
      const steps = planByKey.get(k) ?? [];
      coverageById.set(id, deriveVerificationCoverage(steps, evidenceByKey.get(k) ?? []));
    }

    const linkRows = (
      await c.query<{ source_id: string; target_id: string; relation: string }>(
        'SELECT source_id,target_id,relation FROM foundation.links WHERE source_id = ANY($1::uuid[])',
        [ids],
      )
    ).rows;
    const linksById = new Map<string, { target_id: string; relation: string }[]>();
    for (const l of linkRows) {
      const list = linksById.get(l.source_id) ?? [];
      list.push({ target_id: l.target_id, relation: l.relation });
      linksById.set(l.source_id, list);
    }

    const artifactCountRows = (
      await c.query<{ work_id: string; count: number }>(
        'SELECT work_id,COUNT(*)::int AS count FROM work.artifacts WHERE work_id = ANY($1::uuid[]) GROUP BY work_id',
        [ids],
      )
    ).rows;
    const artifactCountById = new Map<string, number>();
    for (const row of artifactCountRows) artifactCountById.set(row.work_id, row.count);

    const depInputsById = new Map<string, WorkDependencyStateInput[]>();
    for (const id of ids) depInputsById.set(id, []);

    const graphEdges = depsRows.map((d) => {
      const pred = rowById.get(d.predecessor_id);
      const predCoverageState = pred ? coverageById.get(pred.id)?.state : undefined;
      const satisfied =
        !!pred &&
        !pred.deleted_at &&
        (d.gate === 'done' ? pred.status === 'done' : predCoverageState === 'commands_passed');
      depInputsById.get(d.work_id)?.push({
        workId: d.predecessor_id,
        ...(pred ? { title: pred.title } : {}),
        status: pred ? pred.status : 'unknown',
        gate: d.gate,
        satisfied,
        deleted: !pred || pred.deleted_at !== null,
        coverageState: predCoverageState,
      });
      return {
        work_id: d.work_id,
        predecessor_id: d.predecessor_id,
        gate: d.gate,
        satisfied,
      };
    });

    const graphNodes = rows.map((r) => {
      const derived = deriveWorkClaimability(depInputsById.get(r.id) ?? [], {
        status: r.status,
        deleted: r.deleted_at !== null,
        expiresAt: r.expires_at,
        summary: r.summary,
        nowMs,
      });
      return {
        id: r.id,
        revision: r.revision,
        title: r.title,
        description: r.description,
        rank: r.rank,
        priority: r.priority,
        labels: r.labels,
        status: r.status,
        plan_version: r.plan_version,
        summary: r.summary,
        claimable: derived.claimable,
        claimability: toPublicClaimability(derived),
        expires_at: r.expires_at,
        deleted_at: r.deleted_at,
        created_at: r.created_at,
        coverage: coverageById.get(r.id)!,
        links: linksById.get(r.id) ?? [],
        artifactCount: artifactCountById.get(r.id) ?? 0,
      };
    });

    return buildWorkGraph(graphNodes, graphEdges, { rootId: a.rootId });
  }
  const a = operations[name].input.parse(input) as { id: string };
  const w = await item(c, a.id);
  if (
    w.deleted_at &&
    name !== 'work.restore' &&
    !(name === 'work.get' && operations[name].input.parse(input).includeDeleted)
  )
    fail(404, 'not_found', 'Record is unavailable');
  if (name === 'work.lease') {
    const valid = (
      await c.query<{ valid: boolean }>('SELECT $1::timestamptz > clock_timestamp() AS valid', [
        w.expires_at,
      ])
    ).rows[0]?.valid;
    if (
      !valid ||
      !['claimed', 'running'].includes(w.status) ||
      w.claim_principal !== p.id ||
      !w.claim_digest
    )
      fail(409, 'stale_lease', 'An active lease owned by this principal is required');
    return { epoch: w.epoch, claimId: digest(`siftable-lease:${w.claim_digest}`) };
  }
  if (name === 'work.get')
    return {
      ...(await display(c, w)),
      history: (
        await c.query(
          'SELECT event,actor,detail,created_at FROM work.events WHERE work_id=$1 ORDER BY id',
          [w.id],
        )
      ).rows,
      evidence: (
        await c.query(
          'SELECT plan_version,step_id,attempt_id,outcome,output,provenance,submitted_by,created_at FROM work.evidence WHERE work_id=$1 ORDER BY created_at,id',
          [w.id],
        )
      ).rows,
      dependencies: (
        await c.query(
          'SELECT predecessor_id AS id,gate FROM work.dependencies WHERE work_id=$1 ORDER BY predecessor_id',
          [w.id],
        )
      ).rows,
      artifacts: (
        await c.query(
          'SELECT id,name,media_type,digest,plan_version,created_at FROM work.artifacts WHERE work_id=$1 ORDER BY created_at,id',
          [w.id],
        )
      ).rows,
      plans: (
        await c.query(
          'SELECT version,steps,reason,actor FROM work.plans WHERE work_id=$1 ORDER BY version',
          [w.id],
        )
      ).rows,
    };
  if (name === 'work.artifacts.list') {
    const a = operations[name].input.parse(input);
    return (
      await c.query(
        'SELECT id,name,media_type,digest,plan_version,created_at FROM work.artifacts WHERE work_id=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3',
        [w.id, a.limit, a.offset],
      )
    ).rows;
  }
  if (name === 'work.artifacts.get') {
    const a = operations[name].input.parse(input);
    return first(
      (
        await c.query(
          'SELECT id,name,media_type,content,digest,plan_version,created_at FROM work.artifacts WHERE work_id=$1 AND id=$2',
          [w.id, a.artifactId],
        )
      ).rows,
    );
  }
  if (name === 'work.delete' || name === 'work.restore') {
    const a = operations[name].input.parse(input);
    if (!['done', 'failed', 'cancelled'].includes(w.status))
      fail(409, 'invalid_transition', 'Only terminal work may be deleted or restored');
    if (
      name === 'work.delete' &&
      (
        await c.query(
          'SELECT 1 FROM work.dependencies d JOIN foundation.entities e ON e.id=d.work_id WHERE predecessor_id=$1 AND e.deleted_at IS NULL LIMIT 1',
          [w.id],
        )
      ).rowCount
    )
      fail(409, 'referenced_record', 'Work is a dependency of another record');
    if (name === 'work.restore') {
      for (const d of (
        await c.query('SELECT predecessor_id FROM work.dependencies WHERE work_id=$1', [w.id])
      ).rows)
        await reference(c, d.predecessor_id, 'work.item');
    }
    const result = await setDeleted(c, 'work', a, name.endsWith('.restore'));
    await event(c, p, w.id, name, { reason: a.reason });
    return { ...result, deleted: name.endsWith('.delete') };
  }
  if (name === 'work.fork') {
    const v = operations[name].input.parse(input);
    const isActiveLease = w.status === 'claimed' || w.status === 'running';
    const isUnleasedForkable =
      w.status === 'queued' || w.status === 'blocked' || w.status === 'failed';
    if (!isActiveLease && !isUnleasedForkable) {
      const derived = await evaluateClaimability(c, w);
      throw invalidTransitionError({
        workId: w.id,
        operation: name,
        status: w.status,
        revision: w.revision,
        message: 'Fork only queued, blocked, failed, or actively leased work',
        claimability: toPublicClaimability(derived),
      });
    }
    if (isActiveLease) {
      if (v.claimSecret === undefined || v.epoch === undefined) {
        const valid = first(
          (
            await c.query<{ valid: boolean }>(
              'SELECT $1::timestamptz > clock_timestamp() AS valid',
              [w.expires_at],
            )
          ).rows,
        ).valid;
        throw staleLeaseError({
          workId: w.id,
          status: w.status,
          revision: w.revision,
          currentEpoch: w.epoch,
          providedEpoch: v.epoch,
          expiresAt: w.expires_at,
          leaseExpired: w.expires_at !== null ? !valid : undefined,
        });
      }
      await assertLease(c, p, w, { claimSecret: v.claimSecret, epoch: v.epoch });
    }
    if (w.revision !== v.revision) {
      throw revisionConflictError({
        workId: w.id,
        operation: name,
        expectedRevision: v.revision,
        actualRevision: w.revision,
        status: w.status,
      });
    }
    const parentProjectLinks = (
      await c.query<{ target_id: string }>(
        "SELECT target_id FROM foundation.links WHERE source_id=$1 AND relation='belongs_to'",
        [w.id],
      )
    ).rows;
    const defaultSteps = [
      { key: 'complete', title: 'Complete branch and record handback summary', required: true },
    ];
    const branchIds: string[] = [];
    for (const branch of v.branches) {
      const branchId = await entity(c, p, 'work.item');
      await c.query(
        'INSERT INTO work.items(id,owner_id,scope_id,title,description) VALUES($1,$2,$3,$4,$5)',
        [branchId, p.ownerId, p.scopeId, branch.title, branch.description],
      );
      await plan(c, p, branchId, 1, branch.steps ?? defaultSteps, `Forked from ${w.id}`);
      for (const proj of parentProjectLinks) {
        await reference(c, proj.target_id, 'projects.project');
        await link(c, p, branchId, proj.target_id, 'belongs_to');
      }
      await c.query(
        'INSERT INTO work.dependencies(owner_id,scope_id,work_id,predecessor_id,gate) VALUES($1,$2,$3,$4,$5)',
        [p.ownerId, p.scopeId, w.id, branchId, v.gate],
      );
      await event(c, p, branchId, 'created', { forkedFrom: w.id });
      branchIds.push(branchId);
    }
    const current = await coverage(c, w);
    await plan(c, p, w.id, w.plan_version + 1, current.plan.steps, v.reason);
    await c.query(
      "UPDATE work.items SET status='queued',claim_principal=NULL,claim_digest=NULL,expires_at=NULL,plan_version=plan_version+1,summary=NULL,revision=revision+1 WHERE id=$1",
      [w.id],
    );
    const updatedParent = await item(c, w.id);
    await event(c, p, w.id, 'work.fork', {
      reason: v.reason,
      planVersion: updatedParent.plan_version,
      branchIds,
      gate: v.gate,
      ...(isActiveLease ? { releasedLease: true } : {}),
    });
    const branches = await Promise.all(
      branchIds.map(async (bid) => display(c, await item(c, bid))),
    );
    return { parent: await display(c, updatedParent), branches };
  }
  let artifactId: string | undefined;
  let updateDiff: WorkUpdateDiff | undefined;
  if (name === 'work.update' || name === 'work.dependencies.set') {
    const a = operations[name].input.parse(input);
    if (w.status !== 'queued' && w.status !== 'blocked') {
      const derived = await evaluateClaimability(c, w);
      throw invalidTransitionError({
        workId: w.id,
        operation: name,
        status: w.status,
        revision: w.revision,
        message: 'Edit only queued or blocked work',
        claimability: toPublicClaimability(derived),
      });
    }
    if (w.revision !== a.revision) {
      throw revisionConflictError({
        workId: w.id,
        operation: name,
        expectedRevision: a.revision,
        actualRevision: w.revision,
        status: w.status,
      });
    }
    if (name === 'work.update') {
      const v = operations[name].input.parse(input);
      if (v.steps !== undefined && new Set(v.steps.map((x) => x.key)).size !== v.steps.length)
        fail(400, 'duplicate_step', 'Verification step keys must be unique');
      const current = await coverage(c, w);
      updateDiff = computeWorkUpdateDiff(
        {
          title: w.title,
          description: w.description,
          steps: current.plan.steps,
          rank: w.rank,
          priority: w.priority,
          labels: w.labels,
        },
        v,
      );
      const nextTitle = v.title ?? w.title;
      const nextDescription = v.description ?? w.description;
      const nextRank = v.rank ?? w.rank;
      const nextPriority = v.priority ?? w.priority;
      const nextLabels = v.labels ?? w.labels;
      if (updateDiff.invalidatedEvidence) {
        const nextSteps = v.steps ?? normalizeSteps(current.plan.steps);
        await plan(c, p, w.id, w.plan_version + 1, nextSteps, v.reason);
        await c.query(
          'UPDATE work.items SET title=$2,description=$3,rank=$4,priority=$5,labels=$6,plan_version=plan_version+1,summary=NULL WHERE id=$1',
          [w.id, nextTitle, nextDescription, nextRank, nextPriority, nextLabels],
        );
      } else {
        await c.query(
          'UPDATE work.items SET title=$2,description=$3,rank=$4,priority=$5,labels=$6 WHERE id=$1',
          [w.id, nextTitle, nextDescription, nextRank, nextPriority, nextLabels],
        );
      }
    } else {
      const v = operations[name].input.parse(input);
      if (new Set(v.dependencies.map((d) => d.id)).size !== v.dependencies.length)
        fail(400, 'duplicate_dependency', 'Dependencies must be unique');
      for (const d of v.dependencies) {
        await reference(c, d.id, 'work.item');
        const cycle =
          d.id === w.id ||
          (
            await c.query(
              'WITH RECURSIVE ancestors(id) AS (SELECT predecessor_id FROM work.dependencies WHERE work_id=$1 UNION SELECT d.predecessor_id FROM work.dependencies d JOIN ancestors a ON a.id=d.work_id) SELECT 1 FROM ancestors WHERE id=$2 LIMIT 1',
              [d.id, w.id],
            )
          ).rowCount;
        if (cycle) throw dependencyCycleError({ workId: w.id, predecessorId: d.id });
      }
      await c.query('DELETE FROM work.dependencies WHERE work_id=$1', [w.id]);
      for (const d of v.dependencies)
        await c.query(
          'INSERT INTO work.dependencies(owner_id,scope_id,work_id,predecessor_id,gate) VALUES($1,$2,$3,$4,$5)',
          [p.ownerId, p.scopeId, w.id, d.id, d.gate],
        );
      const current = await coverage(c, w);
      await plan(c, p, w.id, w.plan_version + 1, current.plan.steps, a.reason);
      await c.query('UPDATE work.items SET plan_version=plan_version+1,summary=NULL WHERE id=$1', [
        w.id,
      ]);
    }
  } else if (name === 'work.requeue') {
    const v = operations[name].input.parse(input);
    if (!['blocked', 'failed', 'needs_review', 'cancelled'].includes(w.status))
      fail(409, 'invalid_transition', 'Requeue only blocked, failed, reviewed or cancelled work');
    const current = await coverage(c, w);
    // A new execution cycle gets a new verification plan; old success cannot accept a retry.
    await plan(c, p, w.id, w.plan_version + 1, current.plan.steps, v.reason);
    await c.query(
      "UPDATE work.items SET status='queued',plan_version=plan_version+1,summary=NULL,accepted_by=NULL,accepted_plan_version=NULL WHERE id=$1",
      [w.id],
    );
  } else if (name === 'work.claim') {
    const v = operations[name].input.parse(input);
    const derived = await evaluateClaimability(c, w);
    if (!derived.claimable) {
      throw notClaimableError({
        workId: w.id,
        status: w.status,
        revision: w.revision,
        claimability: toPublicClaimability(derived),
        expiresAt: w.expires_at,
      });
    }
    await c.query(
      "UPDATE work.items SET status='claimed',epoch=epoch+1,claim_principal=$2,claim_digest=$3,expires_at=clock_timestamp()+$4*interval '1 second' WHERE id=$1",
      [w.id, p.id, agentWorkClaimTokenDigest(v.claimSecret), v.leaseSeconds],
    );
  } else if (name === 'work.accept') {
    const v = operations[name].input.parse(input);
    if (w.status !== 'needs_review') fail(409, 'not_in_review', 'Work must be in review');
    if ((await coverage(c, w)).coverage.state !== 'commands_passed')
      fail(409, 'evidence_incomplete', 'Required steps must have passing evidence');
    await c.query(
      "UPDATE work.items SET status='done',accepted_by=$2,accepted_plan_version=plan_version,summary=$3 WHERE id=$1",
      [w.id, p.id, v.summary],
    );
  } else if (name === 'work.cancel') {
    if (['done', 'cancelled', 'failed'].includes(w.status))
      fail(409, 'terminal', 'Work is terminal');
    await c.query(
      "UPDATE work.items SET status='cancelled',claim_principal=NULL,claim_digest=NULL,expires_at=NULL WHERE id=$1",
      [w.id],
    );
  } else if (name === 'work.plan.revise') {
    const v = operations[name].input.parse(input);
    if (['done', 'cancelled', 'failed'].includes(w.status))
      fail(409, 'terminal', 'Requeue before revising terminal work');
    if (['claimed', 'running'].includes(w.status))
      fail(409, 'active_work', 'Release work before revising its plan');
    await plan(c, p, w.id, w.plan_version + 1, v.steps, v.reason);
    await c.query(
      "UPDATE work.items SET plan_version=plan_version+1,status='queued',summary=NULL WHERE id=$1",
      [w.id],
    );
  } else {
    const v = operations['work.start'].input
      .pick({ claimSecret: true, epoch: true })
      .strip()
      .parse(input);
    await assertLease(c, p, w, v);
    if (name === 'work.start') {
      if (w.status !== 'claimed') fail(409, 'invalid_transition', 'Only claimed work can start');
      await c.query("UPDATE work.items SET status='running' WHERE id=$1", [w.id]);
    } else if (name === 'work.heartbeat') {
      const v = operations[name].input.parse(input);
      await c.query(
        "UPDATE work.items SET expires_at=clock_timestamp()+$2*interval '1 second' WHERE id=$1",
        [w.id, v.leaseSeconds],
      );
    } else if (name === 'work.block' || name === 'work.fail') {
      const v = operations[name].input.parse(input);
      await c.query(
        'UPDATE work.items SET status=$2,summary=$3,claim_principal=NULL,claim_digest=NULL,expires_at=NULL WHERE id=$1',
        [w.id, name === 'work.block' ? 'blocked' : 'failed', v.reason],
      );
    } else if (name === 'work.artifacts.add') {
      const v = operations[name].input.parse(input);
      artifactId = randomUUID();
      await c.query(
        'INSERT INTO work.artifacts(id,owner_id,scope_id,work_id,plan_version,name,media_type,content,digest,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          artifactId,
          p.ownerId,
          p.scopeId,
          w.id,
          w.plan_version,
          v.name,
          v.mediaType,
          v.content,
          digest(v.content),
          p.id,
        ],
      );
    } else if (name === 'work.release' || name === 'work.review') {
      const summary = name === 'work.review' ? operations[name].input.parse(input).summary : null;
      await c.query(
        'UPDATE work.items SET status=$2,summary=COALESCE($3,summary),claim_principal=NULL,claim_digest=NULL,expires_at=NULL WHERE id=$1',
        [w.id, name === 'work.release' ? 'queued' : 'needs_review', summary],
      );
    } else if (name === 'work.evidence') {
      const v = operations[name].input.parse(input);
      if (v.planVersion !== w.plan_version)
        fail(409, 'stale_plan', 'Evidence must bind to the active plan');
      const pl = await coverage(c, w);
      if (!pl.plan.steps.some((s) => s.id === v.stepId))
        fail(400, 'unknown_step', 'Step is not in the active plan');
      const fingerprint = digest(
        canonical({
          stepId: v.stepId,
          outcome: v.outcome,
          output: v.output,
          provenance: v.provenance,
        }),
      );
      const prior = (
        await c.query(
          'SELECT fingerprint FROM work.evidence WHERE work_id=$1 AND plan_version=$2 AND step_id=$3 AND attempt_id=$4',
          [w.id, v.planVersion, v.stepId, v.attemptId],
        )
      ).rows[0];
      if (prior && prior.fingerprint !== fingerprint)
        fail(409, 'attempt_conflict', 'Attempt identity already has different evidence');
      if (!prior)
        await c.query(
          'INSERT INTO work.evidence(id,owner_id,scope_id,work_id,plan_version,step_id,attempt_id,outcome,output,provenance,submitted_by,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
          [
            randomUUID(),
            p.ownerId,
            p.scopeId,
            w.id,
            v.planVersion,
            v.stepId,
            v.attemptId,
            v.outcome,
            v.output,
            v.provenance,
            p.id,
            fingerprint,
          ],
        );
    } else fail(404, 'unknown_operation', 'Unsupported work operation');
  }
  await c.query('UPDATE work.items SET revision=revision+1 WHERE id=$1', [w.id]);
  const updated = await item(c, w.id);
  await event(c, p, w.id, name, {
    ...('reason' in (input as object) ? { reason: (input as { reason: string }).reason } : {}),
    planVersion: updated.plan_version,
    ...(artifactId ? { artifactId } : {}),
    ...(updateDiff
      ? {
          changedFields: updateDiff.changedFields,
          before: updateDiff.before,
          after: updateDiff.after,
          invalidatedEvidence: updateDiff.invalidatedEvidence,
        }
      : {}),
    ...(name === 'work.dependencies.set'
      ? { dependencies: operations[name].input.parse(input).dependencies }
      : {}),
  });
  return { ...(await display(c, updated)), ...(artifactId ? { artifactId } : {}) };
}
