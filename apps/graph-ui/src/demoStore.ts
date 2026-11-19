import { randomUUID, createHash } from 'node:crypto';
import {
  buildWorkGraph,
  deriveVerificationCoverage,
  type VerificationCoverage,
  type WorkGraphEdgeInput,
  type WorkGraphNodeInput,
  type WorkGraphResult,
} from '@siftable/core';

export interface DemoWorkDetail {
  id: string;
  revision: number;
  title: string;
  description: string;
  status: string;
  plan_version: number;
  summary: string | null;
  claimable: boolean;
  plan: { version: number; steps: DemoStep[] };
  coverage: VerificationCoverage;
  links: unknown[];
  history: { event: string; actor: string; detail: unknown; created_at: string }[];
  evidence: DemoEvidence[];
  dependencies: { id: string; gate: 'done' | 'commands_passed' }[];
  artifacts: Omit<DemoArtifact, 'content'>[];
  plans: { version: number; steps: DemoStep[]; reason: string; actor: string }[];
}

interface DemoStep {
  id: string;
  key: string;
  title: string;
  required: boolean;
}

interface DemoEvidence {
  plan_version: number;
  step_id: string;
  attempt_id: string;
  outcome: 'passed' | 'failed' | 'error';
  output: string;
  provenance: string;
  submitted_by: string;
  created_at: string;
  sequence: number;
}

interface DemoArtifact {
  id: string;
  name: string;
  media_type: string;
  content: string;
  digest: string;
  plan_version: number;
  created_at: string;
}

interface DemoItem {
  id: string;
  revision: number;
  title: string;
  description: string;
  status:
    'queued' | 'claimed' | 'running' | 'blocked' | 'failed' | 'needs_review' | 'done' | 'cancelled';
  plan_version: number;
  summary: string | null;
  created_at: string;
  steps: DemoStep[];
  evidence: DemoEvidence[];
  artifacts: DemoArtifact[];
  history: { event: string; actor: string; detail: unknown; created_at: string }[];
}

interface DemoDep {
  work_id: string;
  predecessor_id: string;
  gate: 'done' | 'commands_passed';
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class DemoWorkStore {
  private items = new Map<string, DemoItem>();
  private deps: DemoDep[] = [];
  private seq = 1;

  constructor() {
    this.seed();
  }

  private addItem(init: {
    id: string;
    title: string;
    description: string;
    status: DemoItem['status'];
    summary?: string | null;
    stepTitle?: string;
    passed?: boolean;
    artifact?: { name: string; content: string };
    createdOffsetMin?: number;
  }) {
    const createdAt = new Date(Date.now() - (init.createdOffsetMin ?? 60) * 60_000).toISOString();
    const stepId = randomUUID();
    const steps: DemoStep[] = [
      {
        id: stepId,
        key: 'verify',
        title: init.stepTitle ?? 'Verify result and record handback summary',
        required: true,
      },
    ];
    const evidence: DemoEvidence[] = init.passed
      ? [
          {
            plan_version: 1,
            step_id: stepId,
            attempt_id: 'attempt-1',
            outcome: 'passed',
            output: 'All checks passed cleanly (demo verification output).',
            provenance: 'demo-worker',
            submitted_by: 'agent-demo',
            created_at: createdAt,
            sequence: this.seq++,
          },
        ]
      : [];
    const artifacts: DemoArtifact[] = init.artifact
      ? [
          {
            id: randomUUID(),
            name: init.artifact.name,
            media_type: 'text/markdown',
            content: init.artifact.content,
            digest: sha(init.artifact.content),
            plan_version: 1,
            created_at: createdAt,
          },
        ]
      : [];
    this.items.set(init.id, {
      id: init.id,
      revision: 1,
      title: init.title,
      description: init.description,
      status: init.status,
      plan_version: 1,
      summary: init.summary ?? null,
      created_at: createdAt,
      steps,
      evidence,
      artifacts,
      history: [{ event: 'created', actor: 'owner-demo', detail: {}, created_at: createdAt }],
    });
  }

  private addDep(workId: string, predecessorId: string, gate: 'done' | 'commands_passed' = 'done') {
    this.deps.push({ work_id: workId, predecessor_id: predecessorId, gate });
  }

  private seed() {
    const r1 = '10000000-0000-4000-8000-000000000001';
    const m1 = '10000000-0000-4000-8000-000000000002';
    const m2 = '10000000-0000-4000-8000-000000000003';
    const m3 = '10000000-0000-4000-8000-000000000004';
    const l1 = '10000000-0000-4000-8000-000000000005';
    const l2 = '10000000-0000-4000-8000-000000000006';
    const l3 = '10000000-0000-4000-8000-000000000007';
    const l4 = '10000000-0000-4000-8000-000000000008';
    const l5 = '10000000-0000-4000-8000-000000000009';
    const l6 = '10000000-0000-4000-8000-000000000010';
    const l7 = '10000000-0000-4000-8000-000000000011';

    const r2 = '20000000-0000-4000-8000-000000000001';
    const r2a = '20000000-0000-4000-8000-000000000002';
    const r2b = '20000000-0000-4000-8000-000000000003';

    this.addItem({
      id: r1,
      title: 'Dependency-Ordered Agent Execution',
      description:
        'Ship local Siftable DAG orchestration and sidecar visualization for parallel Antigravity agents.',
      status: 'queued',
      createdOffsetMin: 120,
    });
    this.addItem({
      id: m1,
      title: 'Graph Query & Metrics Contract',
      description:
        'Provide work.graph with waiting ratios, transitive unblocks, and frontier ordering.',
      status: 'queued',
      createdOffsetMin: 110,
    });
    this.addItem({
      id: m2,
      title: 'Atomic Fork & Handback Protocol',
      description: 'Allow parents to fork into child work items and collect handback artifacts.',
      status: 'queued',
      createdOffsetMin: 105,
    });
    this.addItem({
      id: m3,
      title: 'Antigravity Sidecar & Plugin Wiring',
      description:
        'Package MCP + aux-pane UI sidecar + DAG skill into one local Antigravity plugin.',
      status: 'queued',
      createdOffsetMin: 100,
    });

    this.addItem({
      id: l1,
      title: 'Transitive unblock counts & diamond deduplication',
      description: 'Ensure shared predecessors count distinct downstream dependents once.',
      status: 'done',
      passed: true,
      summary: 'Implemented pure buildWorkGraph() with diamond deduplication and unit tests.',
      artifact: {
        name: 'handback-summary.md',
        content:
          '# Handback Summary\n\n- Added `buildWorkGraph()` in `packages/core/src/workGraph.ts`.\n- Deduplicated diamond ancestors using a memoized downstream set.\n- Verified with `tests/work-graph.test.mjs`.',
      },
      createdOffsetMin: 95,
    });
    this.addItem({
      id: l2,
      title: 'Batched SQL read path for work.graph',
      description:
        'Avoid N+1 queries by fetching items, dependencies, plans, evidence, and artifact counts in batch.',
      status: 'needs_review',
      passed: true,
      summary: 'Batched work.graph SQL query ready for operator acceptance; 0 N+1 queries.',
      artifact: {
        name: 'handback-summary.md',
        content:
          '# Handback Summary\n\n- Added `work.graph` operation in `packages/contracts` and `packages/core/src/work.ts`.\n- Evaluates lease expiry against `clock_timestamp()` and external predecessors accurately.\n- Ready for operator acceptance.',
      },
      createdOffsetMin: 90,
    });
    this.addItem({
      id: l3,
      title: 'Optimistic revision checks on work.fork',
      description:
        'Ensure stale parent revisions fail with revision_conflict and bump plan_version.',
      status: 'queued',
      createdOffsetMin: 85,
    });
    this.addItem({
      id: l4,
      title: 'Handback artifact viewer in sidecar drawer',
      description: 'Render collapsible handback summary + immutable artifact contents cleanly.',
      status: 'needs_review',
      passed: true,
      summary: 'Drawer displays handback summary and fetches immutable artifact content on click.',
      artifact: {
        name: 'ui-notes.md',
        content:
          '# Drawer Notes\n\n- Collapsible handback summary box.\n- Artifact list fetches `/api/work/:id/artifacts/:artifactId` lazily.\n- Works smoothly inside narrow Antigravity aux panes.',
      },
      createdOffsetMin: 80,
    });
    this.addItem({
      id: l5,
      title: 'Layered DAG layout & pan/zoom viewport',
      description: 'Top-down root-to-leaf layout with orange active frontier edges.',
      status: 'done',
      passed: true,
      summary: 'Implemented barycenter layered layout with smooth cubic bezier connectors.',
      createdOffsetMin: 75,
    });
    this.addItem({
      id: l6,
      title: 'Generate sidecar.json & mcp_config.json plugin bundle',
      description: 'Wire Siftable stdio MCP with worker.json and sidecar UI with owner.json.',
      status: 'queued',
      createdOffsetMin: 70,
    });
    this.addItem({
      id: l7,
      title: 'Write siftable-dag Antigravity skill',
      description: 'Document claim -> evidence -> handback -> review -> fork loop for agents.',
      status: 'queued',
      createdOffsetMin: 65,
    });

    this.addDep(r1, m1);
    this.addDep(r1, m2);
    this.addDep(r1, m3);
    this.addDep(m1, l1);
    this.addDep(m1, l2);
    this.addDep(m2, l3);
    this.addDep(m2, l4);
    this.addDep(m2, l5);
    this.addDep(m3, l6);
    this.addDep(m3, l7);

    // Second independent root so the "All roots (2)" dropdown can be exercised immediately.
    this.addItem({
      id: r2,
      title: 'Recovery & Backup Verification Drill',
      description: 'Verify restored snapshot clears active leases and preserves dependency graph.',
      status: 'queued',
      createdOffsetMin: 50,
    });
    this.addItem({
      id: r2a,
      title: 'Run backup-verify on latest local snapshot',
      description: 'Confirm table row counts and SHA-256 digests match manifest.',
      status: 'queued',
      createdOffsetMin: 45,
    });
    this.addItem({
      id: r2b,
      title: 'Verify stale lease rejection after restore',
      description: 'Confirm old worker epoch fails with stale_lease after restore.',
      status: 'queued',
      createdOffsetMin: 40,
    });
    this.addDep(r2, r2a);
    this.addDep(r2, r2b);
  }

  private coverageOf(item: DemoItem) {
    return deriveVerificationCoverage(
      item.steps,
      item.evidence
        .filter((e) => e.plan_version === item.plan_version)
        .map((e) => ({
          stepId: e.step_id,
          outcome: e.outcome,
          ranAt: e.created_at,
          createdAt: e.created_at,
          sequence: e.sequence,
        })),
    );
  }

  graph(rootId?: string): WorkGraphResult {
    const coverageMap = new Map(
      [...this.items.values()].map((item) => [item.id, this.coverageOf(item)]),
    );
    const readyMap = new Map<string, boolean>();
    for (const id of this.items.keys()) readyMap.set(id, true);

    const edges: WorkGraphEdgeInput[] = this.deps.map((d) => {
      const pred = this.items.get(d.predecessor_id);
      const satisfied =
        !!pred &&
        (d.gate === 'done'
          ? pred.status === 'done'
          : coverageMap.get(pred.id)?.state === 'commands_passed');
      if (!satisfied) readyMap.set(d.work_id, false);
      return {
        work_id: d.work_id,
        predecessor_id: d.predecessor_id,
        gate: d.gate,
        satisfied,
      };
    });

    const nodes: WorkGraphNodeInput[] = [...this.items.values()].map((item) => ({
      id: item.id,
      revision: item.revision,
      title: item.title,
      description: item.description,
      status: item.status,
      plan_version: item.plan_version,
      summary: item.summary,
      claimable: item.status === 'queued' && (readyMap.get(item.id) ?? true),
      deleted_at: null,
      created_at: item.created_at,
      coverage: coverageMap.get(item.id)!,
      links: [],
      artifactCount: item.artifacts.length,
    }));

    return buildWorkGraph(nodes, edges, { rootId });
  }

  getWork(id: string): DemoWorkDetail | null {
    const item = this.items.get(id);
    if (!item) return null;
    const g = this.graph();
    const node = g.nodes.find((n) => n.id === id);
    return {
      id: item.id,
      revision: item.revision,
      title: item.title,
      description: item.description,
      status: item.status,
      plan_version: item.plan_version,
      summary: item.summary,
      claimable: node?.claimable ?? false,
      plan: { version: item.plan_version, steps: item.steps },
      coverage: this.coverageOf(item),
      links: [],
      history: item.history,
      evidence: item.evidence,
      dependencies: this.deps
        .filter((d) => d.work_id === id)
        .map((d) => ({ id: d.predecessor_id, gate: d.gate })),
      artifacts: item.artifacts.map((a) => ({
        id: a.id,
        name: a.name,
        media_type: a.media_type,
        digest: a.digest,
        plan_version: a.plan_version,
        created_at: a.created_at,
      })),
      plans: [
        {
          version: item.plan_version,
          steps: item.steps,
          reason: 'Active plan',
          actor: 'owner-demo',
        },
      ],
    };
  }

  getArtifact(workId: string, artifactId: string) {
    const item = this.items.get(workId);
    return item?.artifacts.find((a) => a.id === artifactId) ?? null;
  }

  create(input: {
    title: string;
    description?: string;
    dependencies?: { id: string; gate?: 'done' | 'commands_passed' }[];
    steps?: { key: string; title: string; required?: boolean }[];
  }): DemoWorkDetail | null {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const steps: DemoStep[] = (
      input.steps?.length
        ? input.steps
        : [{ key: 'complete', title: 'Complete work and record verification', required: true }]
    ).map((s) => ({
      id: randomUUID(),
      key: s.key,
      title: s.title,
      required: s.required ?? true,
    }));
    this.items.set(id, {
      id,
      revision: 1,
      title: input.title,
      description: input.description ?? '',
      status: 'queued',
      plan_version: 1,
      summary: null,
      created_at: createdAt,
      steps,
      evidence: [],
      artifacts: [],
      history: [{ event: 'created', actor: 'owner-demo', detail: {}, created_at: createdAt }],
    });
    for (const dep of input.dependencies ?? []) {
      if (this.items.has(dep.id)) this.addDep(id, dep.id, dep.gate ?? 'done');
    }
    return this.getWork(id);
  }

  fork(
    id: string,
    input: {
      reason: string;
      gate?: 'done' | 'commands_passed';
      branches: { title: string; description?: string }[];
    },
  ): { parent: DemoWorkDetail | null; branches: DemoWorkDetail[] } {
    const parent = this.items.get(id);
    if (!parent) throw new Error('Work item not found');
    if (parent.status !== 'queued' && parent.status !== 'blocked')
      throw new Error('Fork only queued or blocked work');
    const created: DemoWorkDetail[] = [];
    for (const b of input.branches) {
      const child = this.create({ title: b.title, description: b.description ?? '' });
      if (child) {
        this.addDep(parent.id, child.id, input.gate ?? 'done');
        created.push(child);
      }
    }
    parent.status = 'queued';
    parent.plan_version += 1;
    parent.revision += 1;
    parent.summary = null;
    parent.history.push({
      event: 'work.fork',
      actor: 'owner-demo',
      detail: { reason: input.reason },
      created_at: new Date().toISOString(),
    });
    return { parent: this.getWork(parent.id), branches: created };
  }

  accept(id: string, summary: string): DemoWorkDetail | null {
    const item = this.items.get(id);
    if (!item) throw new Error('Work item not found');
    if (item.status !== 'needs_review') throw new Error('Work must be in review');
    if (this.coverageOf(item).state !== 'commands_passed')
      throw new Error('Required steps must have passing evidence');
    item.status = 'done';
    item.summary = summary;
    item.revision += 1;
    item.history.push({
      event: 'work.accept',
      actor: 'owner-demo',
      detail: { summary },
      created_at: new Date().toISOString(),
    });
    return this.getWork(id);
  }

  requeue(id: string, reason: string): DemoWorkDetail | null {
    const item = this.items.get(id);
    if (!item) throw new Error('Work item not found');
    if (!['blocked', 'failed', 'needs_review', 'cancelled'].includes(item.status))
      throw new Error('Requeue only blocked, failed, reviewed or cancelled work');
    item.status = 'queued';
    item.plan_version += 1;
    item.revision += 1;
    item.summary = null;
    item.history.push({
      event: 'work.requeue',
      actor: 'owner-demo',
      detail: { reason },
      created_at: new Date().toISOString(),
    });
    return this.getWork(id);
  }

  cancel(id: string, reason: string): DemoWorkDetail | null {
    const item = this.items.get(id);
    if (!item) throw new Error('Work item not found');
    if (['done', 'cancelled', 'failed'].includes(item.status)) throw new Error('Work is terminal');
    item.status = 'cancelled';
    item.revision += 1;
    item.history.push({
      event: 'work.cancel',
      actor: 'owner-demo',
      detail: { reason },
      created_at: new Date().toISOString(),
    });
    return this.getWork(id);
  }
}
