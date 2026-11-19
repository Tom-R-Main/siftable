import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { operations, SiftError, type Operation } from '@siftable/contracts';

export type StructuredToolError = {
  code: string;
  message: string;
  recovery: string;
  status?: number;
};

export type FormattedToolErrorResult = {
  isError: true;
  content: [{ type: 'text'; text: string }];
  structuredContent: { error: StructuredToolError };
};

interface GraphNodeLike {
  id: string;
  revision: number;
  title: string;
  status: string;
  uiState: string;
  planVersion: number;
  claimable: boolean;
  waiting: { satisfied: number; total: number };
  unblocksCount: number;
  depth: number;
}

interface GraphCountsLike {
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

interface GraphLike {
  nodes: GraphNodeLike[];
  next: string[];
  counts: GraphCountsLike;
}

interface WorkListItemLike {
  id: string;
  revision: number;
  title: string;
  status: string;
  plan_version: number;
  claimable: boolean;
  coverage?: { state?: string };
}

const RECOVERY_HINTS: Record<string, string> = {
  revision_conflict:
    'Re-read the record (e.g., work_get, notes_get, projects_get, tasks_get, or objects_get) to obtain the latest revision, then retry with a new requestKey.',
  stale_lease:
    'Check active lease custody or re-claim the work item with work_claim using a new requestKey.',
  not_claimable:
    'Inspect work_graph or work_get for unmet dependencies, active leases, or non-queued status before claiming.',
  idempotency_conflict:
    'Use a new requestKey for changed input, or replay the exact original arguments with the same requestKey to recover the prior receipt.',
  idempotency_required:
    'Provide a stable requestKey string on every write call so retries remain idempotent.',
  stale_plan:
    'Call work_get to fetch the current plan_version and step IDs, then resubmit work_evidence with a new requestKey.',
  unknown_step: 'Call work_get and use a stepId from the active plan.steps list.',
  attempt_conflict:
    'Use a new attemptId and a new requestKey for a new verification attempt on this step.',
  evidence_incomplete:
    'Record passing work_evidence for every required step in the active plan before accepting.',
  invalid_transition:
    'Call work_get or work_graph to inspect the current lifecycle state before retrying.',
  not_in_review: 'Submit the work item with work_review before attempting to accept it.',
  active_work: 'Release or block the active lease before revising the verification plan.',
  terminal:
    'Terminal work items cannot be mutated directly; an operator must call work.requeue if another cycle is needed.',
  dependency_cycle: 'Remove the circular predecessor edge so the work graph remains acyclic.',
  referenced_record: 'Remove or delete dependent records before deleting this record.',
  not_found:
    'Verify the record ID and scope; pass includeDeleted: true on supported reads to inspect deleted records.',
  forbidden:
    'This credential lacks permission or operator role for this operation; use an appropriately scoped credential or hand off to an operator.',
  unauthorized:
    'Verify SIFT_CONFIG points to a valid, unrevoked local credential file with mode 0600.',
  module_unavailable: 'Install and enable the required Siftable module before invoking this tool.',
  invalid_record:
    'Inspect schema_inspect for the extension type and version, then fix the record payload to match its JSON Schema.',
};

const DEFAULT_RECOVERY =
  'Inspect the error code and current state via read tools before retrying with a new requestKey if inputs changed.';

export function toolAnnotations(name: Operation): ToolAnnotations {
  const op = operations[name];
  return {
    readOnlyHint: !op.write,
    destructiveHint:
      op.write && (name.endsWith('.delete') || name === 'work.cancel' || name === 'work.fail'),
    idempotentHint: true,
    openWorldHint: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkGraph(value: unknown): value is GraphLike {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.nodes) &&
    Array.isArray(value.next) &&
    isRecord(value.counts) &&
    typeof value.counts.total === 'number'
  );
}

function isWorkList(value: unknown): value is WorkListItemLike[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        typeof item.status === 'string' &&
        typeof item.revision === 'number',
    )
  );
}

function formatWorkGraph(graph: GraphLike): string {
  const { counts, nodes, next } = graph;
  if (nodes.length === 0) return 'Work graph: 0 items.';

  const buckets = [
    `ready=${counts.ready}`,
    `needs_you=${counts.needsYou}`,
    `active=${counts.active}`,
    `waiting=${counts.waiting}`,
    `done=${counts.done}`,
  ];
  if (counts.failed > 0) buckets.push(`failed=${counts.failed}`);
  if (counts.cancelled > 0) buckets.push(`cancelled=${counts.cancelled}`);

  const lines: string[] = [`Work graph: ${counts.total} items (${buckets.join(', ')})`];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  if (next.length > 0) {
    lines.push(`Next frontier (${next.length}):`);
    for (const id of next) {
      const node = byId.get(id);
      if (!node) continue;
      const flags = [`rev=${node.revision}`, `unblocks=${node.unblocksCount}`];
      if (node.claimable) flags.push('claimable');
      lines.push(`- [${node.uiState}] ${node.id} "${node.title}" (${flags.join(', ')})`);
    }
  }

  lines.push(`Nodes (${nodes.length}):`);
  for (const node of nodes) {
    const indent = '  '.repeat(Math.min(Math.max(node.depth ?? 0, 0), 6));
    const meta = [`status=${node.status}`, `rev=${node.revision}`];
    if (typeof node.planVersion === 'number') meta.push(`plan=v${node.planVersion}`);
    if (node.waiting && node.waiting.total > 0)
      meta.push(`deps=${node.waiting.satisfied}/${node.waiting.total}`);
    if (node.unblocksCount > 0) meta.push(`unblocks=${node.unblocksCount}`);
    if (node.claimable) meta.push('claimable');
    lines.push(`${indent}- [${node.uiState}] ${node.id} "${node.title}" (${meta.join(', ')})`);
  }

  return lines.join('\n');
}

function formatWorkList(items: WorkListItemLike[]): string {
  if (items.length === 0) return 'Work list: 0 items.';
  const lines = [`Work list (${items.length} items):`];
  for (const item of items) {
    const badge = item.claimable ? `${item.status}, claimable` : item.status;
    const meta = [`rev=${item.revision}`];
    if (typeof item.plan_version === 'number') meta.push(`plan=v${item.plan_version}`);
    if (item.coverage?.state) meta.push(`coverage=${item.coverage.state}`);
    lines.push(`- [${badge}] ${item.id} "${item.title}" (${meta.join(', ')})`);
  }
  return lines.join('\n');
}

export function formatToolResultText(operation: Operation, data: unknown): string {
  if (operation === 'work.graph' && isWorkGraph(data)) return formatWorkGraph(data);
  if (operation === 'work.list' && isWorkList(data)) return formatWorkList(data);
  return JSON.stringify(data);
}

export function recoveryHint(code: string): string {
  return RECOVERY_HINTS[code] ?? DEFAULT_RECOVERY;
}

function isSiftError(err: unknown): err is { status: number; code: string; message: string } {
  return (
    err instanceof SiftError ||
    (err instanceof Error &&
      'code' in err &&
      typeof err.code === 'string' &&
      'status' in err &&
      typeof err.status === 'number')
  );
}

export function formatToolError(err: unknown): FormattedToolErrorResult {
  if (isSiftError(err)) {
    const recovery = recoveryHint(err.code);
    return {
      isError: true,
      content: [{ type: 'text', text: `[${err.code}] ${err.message}\nRecovery: ${recovery}` }],
      structuredContent: {
        error: {
          code: err.code,
          status: err.status,
          message: err.message,
          recovery,
        },
      },
    };
  }

  const message = err instanceof Error ? err.message : 'Operation failed';
  let code = 'tool_error';
  let recovery = 'Check the tool arguments and local Siftable server status, then retry.';

  if (message.includes('unavailable for this module profile')) {
    code = 'tool_unavailable';
    recovery =
      'Call listTools to inspect tools authorized by the active credential and SIFT_TOOLS profile.';
  } else if (message.includes('No saved lease')) {
    code = 'missing_lease';
    recovery = 'Claim the work item with work_claim using this credential first.';
  } else if (message.includes('stable request key')) {
    code = 'idempotency_required';
    recovery = recoveryHint('idempotency_required');
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `[${code}] ${message}\nRecovery: ${recovery}` }],
    structuredContent: {
      error: {
        code,
        message,
        recovery,
      },
    },
  };
}
