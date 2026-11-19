import { SiftError } from '@siftable/contracts';

export type WorkClaimabilityState =
  | 'ready'
  | 'waiting'
  | 'dependency_failed'
  | 'leased'
  | 'lease_expired'
  | 'blocked'
  | 'in_review'
  | 'terminal';

export type WorkClaimabilityNextAction =
  | 'work.claim'
  | 'wait_for_dependencies'
  | 'unblock_or_requeue_predecessor'
  | 'wait_for_lease_or_reclaim'
  | 'work.requeue'
  | 'work.review_or_accept'
  | 'none';

export interface WorkDependencyStateInput {
  workId: string;
  title?: string;
  status: string;
  gate: 'done' | 'commands_passed';
  satisfied: boolean;
  deleted?: boolean;
  coverageState?: string;
}

export interface WorkBlockedBy {
  workId: string;
  title?: string;
  status: string;
  gate: 'done' | 'commands_passed';
  reason: string;
}

export interface WorkClaimability {
  state: WorkClaimabilityState;
  reason: string;
  nextAction: WorkClaimabilityNextAction;
  blockedBy: WorkBlockedBy[];
}

export interface DerivedWorkClaimability extends WorkClaimability {
  claimable: boolean;
}

export interface WorkClaimabilityContext {
  status: string;
  deleted?: boolean;
  expiresAt?: Date | string | null;
  summary?: string | null;
  nowMs?: number;
}

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);
const FAILED_DEPENDENCY_STATUSES = new Set(['failed', 'cancelled']);

function parseExpiry(expiresAt: Date | string | null | undefined): {
  ms: number | null;
  iso: string | null;
} {
  if (expiresAt === null || expiresAt === undefined) return { ms: null, iso: null };
  if (expiresAt instanceof Date) {
    const ms = expiresAt.getTime();
    return Number.isNaN(ms) ? { ms: null, iso: null } : { ms, iso: expiresAt.toISOString() };
  }
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) ? { ms: null, iso: null } : { ms, iso: new Date(ms).toISOString() };
}

function isDependencyFailed(dependency: WorkDependencyStateInput): boolean {
  return Boolean(dependency.deleted) || FAILED_DEPENDENCY_STATUSES.has(dependency.status);
}

function describeBlockedDependency(dependency: WorkDependencyStateInput): string {
  if (dependency.deleted) return 'Predecessor was deleted and cannot satisfy the dependency gate.';
  if (dependency.status === 'failed') return 'Predecessor failed.';
  if (dependency.status === 'cancelled') return 'Predecessor was cancelled.';
  if (dependency.status === 'blocked')
    return `Predecessor is blocked and has not satisfied the ${dependency.gate} gate.`;
  if (dependency.gate === 'done')
    return `Predecessor is ${dependency.status}; waiting for status "done".`;
  return `Predecessor is ${dependency.status} (${dependency.coverageState ?? 'unverified'}); waiting for verification state "commands_passed".`;
}

function toBlockedByEntry(dependency: WorkDependencyStateInput): WorkBlockedBy {
  return {
    workId: dependency.workId,
    ...(dependency.title !== undefined ? { title: dependency.title } : {}),
    status: dependency.deleted ? 'deleted' : dependency.status,
    gate: dependency.gate,
    reason: describeBlockedDependency(dependency),
  };
}

export function deriveWorkClaimability(
  dependencies: WorkDependencyStateInput[],
  context: WorkClaimabilityContext,
): DerivedWorkClaimability {
  if (context.deleted) {
    return {
      state: 'terminal',
      claimable: false,
      reason: 'Work item is deleted and cannot be claimed.',
      nextAction: 'none',
      blockedBy: [],
    };
  }

  const { status } = context;

  if (TERMINAL_STATUSES.has(status)) {
    return {
      state: 'terminal',
      claimable: false,
      reason: `Work item is ${status}; terminal items cannot be claimed.`,
      nextAction: 'none',
      blockedBy: [],
    };
  }

  if (status === 'needs_review') {
    return {
      state: 'in_review',
      claimable: false,
      reason: 'Work item is awaiting review; accept or requeue it instead of claiming.',
      nextAction: 'work.review_or_accept',
      blockedBy: [],
    };
  }

  if (status === 'blocked') {
    const detail = context.summary?.trim();
    return {
      state: 'blocked',
      claimable: false,
      reason: detail
        ? `Work item is blocked: ${detail}. Requeue or fork it before claiming.`
        : 'Work item is blocked; requeue or fork it before claiming.',
      nextAction: 'work.requeue',
      blockedBy: [],
    };
  }

  const unmet = dependencies.filter((d) => !d.satisfied || d.deleted);
  const failedCount = unmet.filter(isDependencyFailed).length;
  const blockedBy = unmet.map(toBlockedByEntry);

  const dependencyResult = (): DerivedWorkClaimability | null => {
    if (failedCount > 0) {
      return {
        state: 'dependency_failed',
        claimable: false,
        reason: `${failedCount} required predecessor${failedCount === 1 ? '' : 's'} failed or cancelled; unblock or requeue before claiming.`,
        nextAction: 'unblock_or_requeue_predecessor',
        blockedBy,
      };
    }
    if (blockedBy.length > 0) {
      return {
        state: 'waiting',
        claimable: false,
        reason: `${blockedBy.length} required predecessor${blockedBy.length === 1 ? ' has' : 's have'} not satisfied its dependency gate.`,
        nextAction: 'wait_for_dependencies',
        blockedBy,
      };
    }
    return null;
  };

  if (status === 'claimed' || status === 'running') {
    const nowMs = context.nowMs ?? Date.now();
    const expiry = parseExpiry(context.expiresAt);
    const expired = expiry.ms !== null && expiry.ms <= nowMs;
    if (expired) {
      const depBlock = dependencyResult();
      if (depBlock) return depBlock;
      return {
        state: 'lease_expired',
        claimable: true,
        reason: expiry.iso
          ? `Lease expired at ${expiry.iso}; work item can be reclaimed now.`
          : 'Lease expired; work item can be reclaimed now.',
        nextAction: 'work.claim',
        blockedBy: [],
      };
    }
    return {
      state: 'leased',
      claimable: false,
      reason: expiry.iso
        ? `Work item is actively leased until ${expiry.iso}.`
        : 'Work item is leased without an expiry timestamp.',
      nextAction: 'wait_for_lease_or_reclaim',
      blockedBy: [],
    };
  }

  const depBlock = dependencyResult();
  if (depBlock) return depBlock;

  return {
    state: 'ready',
    claimable: true,
    reason: 'Queued with all dependencies satisfied.',
    nextAction: 'work.claim',
    blockedBy: [],
  };
}

export const deriveAgentWorkClaimability = deriveWorkClaimability;

export function toPublicClaimability(derived: DerivedWorkClaimability): WorkClaimability {
  return {
    state: derived.state,
    reason: derived.reason,
    nextAction: derived.nextAction,
    blockedBy: derived.blockedBy,
  };
}

export function notClaimableError(args: {
  workId: string;
  status: string;
  revision: number;
  claimability: WorkClaimability;
  expiresAt?: Date | string | null;
}): SiftError {
  const { claimability } = args;
  let suggestions: string[];
  switch (claimability.state) {
    case 'waiting':
      suggestions = [
        'Wait for unmet predecessors to satisfy their dependency gates before claiming.',
        'Inspect dependency progress with work.get or work.graph.',
      ];
      break;
    case 'dependency_failed':
      suggestions = [
        'Requeue or unblock failed/cancelled predecessors, or update dependencies via work.dependencies.set.',
        'Inspect blockedBy predecessors with work.get or work.graph.',
      ];
      break;
    case 'leased':
      suggestions = [
        'Wait for the active lease to be released or expire before claiming.',
        'Call work.get to inspect current status and lease expiry.',
      ];
      break;
    case 'blocked':
      suggestions = [
        'Call work.requeue to move blocked work back to queued before claiming, or fork it with work.fork.',
      ];
      break;
    case 'in_review':
      suggestions = [
        'Accept the work item with work.accept, or call work.requeue to start a new verification cycle.',
      ];
      break;
    default:
      suggestions = [
        'Terminal work cannot be claimed directly; call work.requeue on failed/cancelled items if another cycle is needed.',
      ];
      break;
  }

  const expiry = parseExpiry(args.expiresAt);
  const details: Record<string, unknown> = {
    workId: args.workId,
    status: args.status,
    revision: args.revision,
    claimability,
    ...(claimability.blockedBy.length > 0
      ? { unmetPredecessorIds: claimability.blockedBy.map((b) => b.workId) }
      : {}),
    ...(claimability.state === 'leased' && expiry.iso ? { expiresAt: expiry.iso } : {}),
  };

  return new SiftError(
    409,
    'not_claimable',
    `Work is not claimable (${claimability.state}): ${claimability.reason}`,
    suggestions,
    details,
  );
}

export function revisionConflictError(args: {
  workId: string;
  operation: string;
  expectedRevision: number;
  actualRevision: number;
  status: string;
}): SiftError {
  return new SiftError(
    409,
    'revision_conflict',
    `Work revision changed (expected ${args.expectedRevision}, actual ${args.actualRevision})`,
    [
      'Call work.get to read the latest revision and current state, then retry with the updated revision and a new requestKey.',
    ],
    {
      workId: args.workId,
      operation: args.operation,
      expectedRevision: args.expectedRevision,
      actualRevision: args.actualRevision,
      status: args.status,
    },
  );
}

export function staleLeaseError(args: {
  workId: string;
  status: string;
  revision: number;
  currentEpoch: number;
  providedEpoch?: number;
  expiresAt?: Date | string | null;
  leaseExpired?: boolean;
}): SiftError {
  const expiry = parseExpiry(args.expiresAt);
  const activeStatus = args.status === 'claimed' || args.status === 'running';
  const suggestions =
    activeStatus && args.leaseExpired
      ? [
          'The lease on this work item has expired; re-claim it with work.claim using a new requestKey before retrying.',
        ]
      : activeStatus
        ? [
            'Only the active lease holder at the current epoch may mutate this leased work item; wait for lease release/expiry or verify local lease custody.',
          ]
        : ['Work is not actively leased; call work.get to inspect current status before retrying.'];

  return new SiftError(
    409,
    'stale_lease',
    'An active lease owned by this principal and epoch is required',
    suggestions,
    {
      workId: args.workId,
      status: args.status,
      revision: args.revision,
      currentEpoch: args.currentEpoch,
      ...(args.providedEpoch !== undefined ? { providedEpoch: args.providedEpoch } : {}),
      ...(expiry.iso ? { expiresAt: expiry.iso } : {}),
      ...(args.leaseExpired !== undefined ? { leaseExpired: args.leaseExpired } : {}),
    },
  );
}

export function invalidTransitionError(args: {
  workId: string;
  operation: string;
  status: string;
  revision: number;
  message: string;
  claimability?: WorkClaimability;
}): SiftError {
  let suggestions: string[];
  if (args.operation === 'work.fork') {
    suggestions =
      args.status === 'needs_review'
        ? [
            'Accept the work item with work.accept, or call work.requeue before forking into branches.',
          ]
        : [
            'Fork only queued, blocked, failed, or actively leased work; create a follow-up item or requeue cancelled work first.',
          ];
  } else if (args.status === 'claimed' || args.status === 'running') {
    suggestions = [
      'Release or block the active lease (work.release or work.block) before editing or changing dependencies.',
    ];
  } else if (args.status === 'needs_review') {
    suggestions = ['Call work.requeue to move the item back to queued before editing.'];
  } else {
    suggestions = [
      'Call work.requeue on failed or cancelled work before editing; done work cannot be edited.',
    ];
  }

  return new SiftError(409, 'invalid_transition', args.message, suggestions, {
    workId: args.workId,
    operation: args.operation,
    status: args.status,
    revision: args.revision,
    ...(args.claimability ? { claimability: args.claimability } : {}),
  });
}

export function dependencyCycleError(args: { workId: string; predecessorId: string }): SiftError {
  return new SiftError(
    409,
    'dependency_cycle',
    'Dependency would create a cycle',
    ['Remove the circular predecessor edge so the work graph remains acyclic.'],
    {
      workId: args.workId,
      predecessorId: args.predecessorId,
    },
  );
}
