import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { operations, canonical, type Operation, type Principal } from '@siftable/contracts';
import { setDeleted } from './lifecycle.js';
import { digest } from './database.js';
import { agentWorkClaimTokenDigest } from './claimDigest.js';
import { deriveVerificationCoverage } from './verificationCoverage.js';
import type { VerificationStep } from './verificationTypes.js';
import { entity, reference, link, first, fail } from './helpers.js';
interface WorkRow {
  id: string;
  revision: number;
  deleted_at: Date | null;
  title: string;
  description: string;
  status: string;
  epoch: number;
  claim_principal: string | null;
  claim_digest: string | null;
  expires_at: Date | null;
  plan_version: number;
  summary: string | null;
  accepted_by: string | null;
  accepted_plan_version: number | null;
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
async function dependenciesReady(c: PoolClient, id: string): Promise<boolean> {
  const deps = await c.query<{ predecessor_id: string; gate: string }>(
    'SELECT predecessor_id,gate FROM work.dependencies WHERE work_id=$1',
    [id],
  );
  for (const d of deps.rows) {
    const w = await item(c, d.predecessor_id);
    if (
      w.deleted_at ||
      (d.gate === 'done'
        ? w.status !== 'done'
        : (await coverage(c, w)).coverage.state !== 'commands_passed')
    )
      return false;
  }
  return true;
}
async function display(c: PoolClient, w: WorkRow) {
  const { claim_digest: _digest, claim_principal: _claim, ...publicFields } = w;
  const now = first(
    (
      await c.query<{ expired: boolean }>(
        'SELECT $1::timestamptz <= clock_timestamp() AS expired',
        [w.expires_at],
      )
    ).rows,
  );
  const ready = await dependenciesReady(c, w.id);
  return {
    ...publicFields,
    ...(await coverage(c, w)),
    claimable:
      !w.deleted_at &&
      ready &&
      (w.status === 'queued' || (['claimed', 'running'].includes(w.status) && now.expired)),
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
    fail(409, 'stale_lease', 'An active lease owned by this principal and epoch is required');
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
      'INSERT INTO work.items(id,owner_id,scope_id,title,description) VALUES($1,$2,$3,$4,$5)',
      [id, p.ownerId, p.scopeId, a.title, a.description],
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
      'SELECT w.*,e.deleted_at FROM work.items w JOIN foundation.entities e USING(id) WHERE ($3 OR e.deleted_at IS NULL) ORDER BY w.created_at,w.id LIMIT $1 OFFSET $2',
      [a.limit, a.offset, a.includeDeleted],
    );
    return Promise.all(r.rows.map((w) => display(c, w)));
  }
  const a = operations[name].input.parse(input) as { id: string };
  const w = await item(c, a.id);
  if (
    w.deleted_at &&
    name !== 'work.restore' &&
    !(name === 'work.get' && operations[name].input.parse(input).includeDeleted)
  )
    fail(404, 'not_found', 'Record is unavailable');
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
  let artifactId: string | undefined;
  if (name === 'work.update' || name === 'work.dependencies.set') {
    const a = operations[name].input.parse(input);
    if (w.status !== 'queued' && w.status !== 'blocked')
      fail(409, 'invalid_transition', 'Edit only queued or blocked work');
    if (w.revision !== a.revision) fail(409, 'revision_conflict', 'Work revision changed');
    if (name === 'work.update') {
      const v = operations[name].input.parse(input);
      await c.query('UPDATE work.items SET title=$2,description=$3 WHERE id=$1', [
        w.id,
        v.title,
        v.description,
      ]);
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
        if (cycle) fail(409, 'dependency_cycle', 'Dependency would create a cycle');
      }
      await c.query('DELETE FROM work.dependencies WHERE work_id=$1', [w.id]);
      for (const d of v.dependencies)
        await c.query(
          'INSERT INTO work.dependencies(owner_id,scope_id,work_id,predecessor_id,gate) VALUES($1,$2,$3,$4,$5)',
          [p.ownerId, p.scopeId, w.id, d.id, d.gate],
        );
    }
    const current = await coverage(c, w);
    await plan(c, p, w.id, w.plan_version + 1, current.plan.steps, a.reason);
    await c.query('UPDATE work.items SET plan_version=plan_version+1,summary=NULL WHERE id=$1', [
      w.id,
    ]);
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
    if (!(await display(c, w)).claimable)
      fail(
        409,
        'not_claimable',
        'Work is terminal, leased, in review, or waiting for dependencies',
      );
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
    ...(name === 'work.dependencies.set'
      ? { dependencies: operations[name].input.parse(input).dependencies }
      : {}),
  });
  return { ...(await display(c, updated)), ...(artifactId ? { artifactId } : {}) };
}
