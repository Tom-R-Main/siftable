import type { VerificationCoverage } from './verificationTypes.js';
import {
  deriveWorkClaimability,
  toPublicClaimability,
  type WorkClaimability,
  type WorkDependencyStateInput,
} from './claimability.js';

export type WorkUiState =
  'ready' | 'waiting' | 'active' | 'needs_you' | 'done' | 'failed' | 'cancelled';

export type WorkPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface WorkGraphLink {
  target_id: string;
  relation: string;
}

export interface WorkGraphNodeInput {
  id: string;
  revision: number;
  title: string;
  description: string;
  rank?: number;
  priority?: WorkPriority;
  labels?: string[];
  status: string;
  plan_version: number;
  summary: string | null;
  claimable: boolean;
  claimability?: WorkClaimability;
  expires_at?: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
  coverage: VerificationCoverage;
  links: WorkGraphLink[];
  artifactCount?: number;
}

export interface WorkGraphEdgeInput {
  work_id: string;
  predecessor_id: string;
  gate: 'done' | 'commands_passed';
  satisfied: boolean;
}

export interface WorkGraphNode {
  id: string;
  revision: number;
  title: string;
  description: string;
  rank: number;
  priority: WorkPriority;
  labels: string[];
  status: string;
  uiState: WorkUiState;
  kind: 'thread' | 'leaf';
  planVersion: number;
  summary: string | null;
  claimable: boolean;
  claimability: WorkClaimability;
  deleted: boolean;
  createdAt: string;
  coverage: VerificationCoverage;
  links: WorkGraphLink[];
  artifactCount: number;
  waiting: {
    satisfied: number;
    total: number;
  };
  directUnblocksCount: number;
  unblocksCount: number;
  isRoot: boolean;
  isLeaf: boolean;
  depth: number;
  rootIds: string[];
  predecessorIds: string[];
  dependentIds: string[];
}

export interface WorkGraphEdge {
  id: string;
  workId: string;
  predecessorId: string;
  gate: 'done' | 'commands_passed';
  satisfied: boolean;
  active: boolean;
}

export interface WorkGraphRootSummary {
  id: string;
  title: string;
  uiState: WorkUiState;
  totalNodes: number;
  openNodes: number;
  readyCount: number;
  needsYouCount: number;
}

export interface WorkGraphCounts {
  total: number;
  ready: number;
  waiting: number;
  active: number;
  needsYou: number;
  done: number;
  failed: number;
  cancelled: number;
  next: number;
}

export interface WorkGraphResult {
  nodes: WorkGraphNode[];
  edges: WorkGraphEdge[];
  roots: WorkGraphRootSummary[];
  next: string[];
  counts: WorkGraphCounts;
}

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

export function deriveWorkUiState(status: string, claimable: boolean): WorkUiState {
  if (status === 'done') return 'done';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'needs_review' || status === 'blocked') return 'needs_you';
  if (status === 'claimed' || status === 'running') return 'active';
  return claimable ? 'ready' : 'waiting';
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function buildWorkGraph(
  rawNodes: WorkGraphNodeInput[],
  rawEdges: WorkGraphEdgeInput[],
  options: { rootId?: string } = {},
): WorkGraphResult {
  const nodeMap = new Map<string, WorkGraphNodeInput>();
  for (const n of rawNodes) nodeMap.set(n.id, n);

  // Only keep edges whose endpoints exist in the node set.
  const validEdges = rawEdges.filter(
    (e) => nodeMap.has(e.work_id) && nodeMap.has(e.predecessor_id),
  );

  // Adjacency:
  // predecessorsOf[workId] = list of predecessor edges (children below)
  // dependentsOf[predecessorId] = list of dependent workIds (parents above)
  const predecessorsOf = new Map<string, WorkGraphEdgeInput[]>();
  const dependentsOf = new Map<string, string[]>();
  for (const id of nodeMap.keys()) {
    predecessorsOf.set(id, []);
    dependentsOf.set(id, []);
  }
  for (const edge of validEdges) {
    predecessorsOf.get(edge.work_id)!.push(edge);
    dependentsOf.get(edge.predecessor_id)!.push(edge.work_id);
  }

  // Transitive downstream dependents (ancestors in the visual tree) for each node.
  const downstreamCache = new Map<string, Set<string>>();
  function getDownstream(id: string, visiting = new Set<string>()): Set<string> {
    const cached = downstreamCache.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return new Set();
    visiting.add(id);
    const acc = new Set<string>();
    for (const parentId of dependentsOf.get(id) ?? []) {
      acc.add(parentId);
      for (const ancestorId of getDownstream(parentId, visiting)) {
        acc.add(ancestorId);
      }
    }
    visiting.delete(id);
    downstreamCache.set(id, acc);
    return acc;
  }

  // Identify roots (nodes with zero dependents).
  const rootIdSet = new Set<string>();
  for (const [id, deps] of dependentsOf.entries()) {
    if (deps.length === 0) rootIdSet.add(id);
  }

  // Longest path depth from any root (roots = 0, children = max(parent.depth) + 1).
  const depthCache = new Map<string, number>();
  function getDepth(id: string, visiting = new Set<string>()): number {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    const parents = dependentsOf.get(id) ?? [];
    if (parents.length === 0) {
      depthCache.set(id, 0);
      return 0;
    }
    visiting.add(id);
    let maxParent = 0;
    for (const p of parents) {
      maxParent = Math.max(maxParent, getDepth(p, visiting));
    }
    visiting.delete(id);
    const d = maxParent + 1;
    depthCache.set(id, d);
    return d;
  }

  // Build full node list first so root summaries and metrics reflect the whole scope.
  const fullNodes = new Map<string, WorkGraphNode>();
  for (const raw of rawNodes) {
    const preds = predecessorsOf.get(raw.id) ?? [];
    const deps = dependentsOf.get(raw.id) ?? [];
    const downstream = getDownstream(raw.id);
    const uiState = deriveWorkUiState(raw.status, raw.claimable);
    const isTerminal = TERMINAL_STATUSES.has(raw.status);

    let unblocksCount = 0;
    let directUnblocksCount = 0;
    if (!isTerminal) {
      for (const targetId of downstream) {
        const target = nodeMap.get(targetId);
        if (target && !TERMINAL_STATUSES.has(target.status)) unblocksCount++;
      }
      for (const targetId of deps) {
        const target = nodeMap.get(targetId);
        if (target && !TERMINAL_STATUSES.has(target.status)) directUnblocksCount++;
      }
    }

    const rootIds: string[] = [];
    if (rootIdSet.has(raw.id)) {
      rootIds.push(raw.id);
    } else {
      for (const targetId of downstream) {
        if (rootIdSet.has(targetId)) rootIds.push(targetId);
      }
    }
    rootIds.sort();

    const satisfied = preds.filter((e) => e.satisfied).length;
    const claimability: WorkClaimability =
      raw.claimability ??
      toPublicClaimability(
        deriveWorkClaimability(
          preds.map((edge): WorkDependencyStateInput => {
            const predNode = nodeMap.get(edge.predecessor_id);
            return {
              workId: edge.predecessor_id,
              ...(predNode ? { title: predNode.title } : {}),
              status: predNode?.status ?? 'unknown',
              gate: edge.gate,
              satisfied: edge.satisfied,
              deleted: predNode ? predNode.deleted_at !== null : false,
              coverageState: predNode?.coverage.state,
            };
          }),
          {
            status: raw.status,
            deleted: raw.deleted_at !== null,
            expiresAt:
              raw.expires_at !== undefined
                ? raw.expires_at
                : (raw.status === 'claimed' || raw.status === 'running') && raw.claimable
                  ? new Date(0)
                  : null,
            summary: raw.summary,
          },
        ),
      );

    fullNodes.set(raw.id, {
      id: raw.id,
      revision: raw.revision,
      title: raw.title,
      description: raw.description,
      rank: raw.rank ?? 0,
      priority: raw.priority ?? 'normal',
      labels: raw.labels ? [...raw.labels] : [],
      status: raw.status,
      uiState,
      kind: preds.length === 0 ? 'leaf' : 'thread',
      planVersion: raw.plan_version,
      summary: raw.summary,
      claimable: raw.claimable,
      claimability,
      deleted: raw.deleted_at !== null,
      createdAt: toIso(raw.created_at),
      coverage: raw.coverage,
      links: raw.links,
      artifactCount: raw.artifactCount ?? 0,
      waiting: { satisfied, total: preds.length },
      directUnblocksCount,
      unblocksCount,
      isRoot: deps.length === 0,
      isLeaf: preds.length === 0,
      depth: getDepth(raw.id),
      rootIds,
      predecessorIds: preds.map((e) => e.predecessor_id),
      dependentIds: [...deps],
    });
  }

  // Compute summaries for every root across the full scope so the root dropdown always lists all roots.
  const roots: WorkGraphRootSummary[] = [];
  for (const rId of rootIdSet) {
    const rootNode = fullNodes.get(rId);
    if (!rootNode) continue;
    let totalNodes = 0;
    let openNodes = 0;
    let readyCount = 0;
    let needsYouCount = 0;
    for (const n of fullNodes.values()) {
      if (n.id === rId || n.rootIds.includes(rId)) {
        totalNodes++;
        if (!TERMINAL_STATUSES.has(n.status)) openNodes++;
        if (n.uiState === 'ready') readyCount++;
        if (n.uiState === 'needs_you') needsYouCount++;
      }
    }
    roots.push({
      id: rootNode.id,
      title: rootNode.title,
      uiState: rootNode.uiState,
      totalNodes,
      openNodes,
      readyCount,
      needsYouCount,
    });
  }
  roots.sort((a, b) => {
    const aActive = a.needsYouCount + a.readyCount;
    const bActive = b.needsYouCount + b.readyCount;
    if (bActive !== aActive) return bActive - aActive;
    return a.title.localeCompare(b.title);
  });

  // Optionally restrict returned subgraph to a single rootId and its transitive predecessors.
  let visibleIds: Set<string>;
  if (options.rootId) {
    visibleIds = new Set<string>();
    if (fullNodes.has(options.rootId)) {
      const queue = [options.rootId];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (visibleIds.has(cur)) continue;
        visibleIds.add(cur);
        for (const edge of predecessorsOf.get(cur) ?? []) {
          if (!visibleIds.has(edge.predecessor_id)) queue.push(edge.predecessor_id);
        }
      }
    }
  } else {
    visibleIds = new Set(fullNodes.keys());
  }

  const nodes = [...fullNodes.values()]
    .filter((n) => visibleIds.has(n.id))
    .sort(
      (a, b) =>
        a.depth - b.depth || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );

  const edges: WorkGraphEdge[] = validEdges
    .filter((e) => visibleIds.has(e.work_id) && visibleIds.has(e.predecessor_id))
    .map((e) => {
      const child = fullNodes.get(e.predecessor_id)!;
      const active =
        !e.satisfied &&
        (child.uiState === 'ready' || child.uiState === 'needs_you' || child.uiState === 'active');
      return {
        id: `${e.predecessor_id}->${e.work_id}`,
        workId: e.work_id,
        predecessorId: e.predecessor_id,
        gate: e.gate,
        satisfied: e.satisfied,
        active,
      };
    });

  const counts: WorkGraphCounts = {
    total: nodes.length,
    ready: 0,
    waiting: 0,
    active: 0,
    needsYou: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    next: 0,
  };
  for (const n of nodes) {
    if (n.uiState === 'ready') counts.ready++;
    else if (n.uiState === 'waiting') counts.waiting++;
    else if (n.uiState === 'active') counts.active++;
    else if (n.uiState === 'needs_you') counts.needsYou++;
    else if (n.uiState === 'done') counts.done++;
    else if (n.uiState === 'failed') counts.failed++;
    else if (n.uiState === 'cancelled') counts.cancelled++;
  }
  counts.next = counts.ready + counts.needsYou;

  const next = nodes
    .filter((n) => n.uiState === 'needs_you' || n.uiState === 'ready')
    .sort((a, b) => {
      if (b.unblocksCount !== a.unblocksCount) return b.unblocksCount - a.unblocksCount;
      if (a.uiState !== b.uiState) return a.uiState === 'needs_you' ? -1 : 1;
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    })
    .map((n) => n.id);

  return { nodes, edges, roots, next, counts };
}
