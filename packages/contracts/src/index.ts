import { z } from 'zod';
export const moduleIds = [
  'foundation',
  'projects',
  'context',
  'work',
  'planning',
  'extensions',
] as const;
export type ModuleId = (typeof moduleIds)[number];
export const moduleSchema = z.enum(moduleIds);
export const searchDomains = ['note', 'task', 'project', 'object'] as const;
export type SearchDomain = (typeof searchDomains)[number];
export const searchDomainSchema = z.enum(searchDomains);
export const packetOmissionTypes = [
  'budget_exceeded',
  'module_disabled',
  'scope_excluded',
  'not_found',
  'deleted',
] as const;
export type PacketOmissionType = (typeof packetOmissionTypes)[number];
export const packetOmissionTypeSchema = z.enum(packetOmissionTypes);
export const id = z.uuid();
const title = z.string().trim().min(1).max(500);
const text = z.string().max(100_000);
const key = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*$/)
  .max(120);
const ref = z.object({ id, type: key }).strict();
const step = z
  .object({ key: z.string().min(1).max(128), title, required: z.boolean().default(true) })
  .strict();
const page = {
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).max(100_000).default(0),
};
const revision = z.number().int().positive();
const readId = z.object({ id, includeDeleted: z.boolean().default(false) }).strict();
const remove = z.object({ id, revision, reason: title }).strict();
const dependency = z
  .object({ id, gate: z.enum(['done', 'commands_passed']).default('done') })
  .strict();
const lease = { id, claimSecret: z.string().min(32).max(256), epoch: z.number().int().positive() };
const op = <S extends z.ZodType>(
  module: ModuleId,
  write: boolean,
  operator: boolean,
  input: S,
) => ({ module, write, operator, input });
export const operations = {
  'modules.list': op('foundation', false, false, z.object({}).strict()),
  'modules.set': op(
    'foundation',
    true,
    true,
    z.object({ module: moduleSchema, enabled: z.boolean() }).strict(),
  ),
  'schema.inspect': op('foundation', false, false, z.object({}).strict()),
  // Lease holders can resolve custody without permission to read work content.
  'work.lease': op('work', false, false, z.object({ id }).strict()),
  'projects.create': op(
    'projects',
    true,
    false,
    z.object({ title, instructions: text.default('') }).strict(),
  ),
  'projects.get': op('projects', false, false, readId),
  'projects.list': op(
    'projects',
    false,
    false,
    z.object({ ...page, includeDeleted: z.boolean().default(false) }).strict(),
  ),
  'projects.bind': op(
    'projects',
    true,
    false,
    z
      .object({
        projectId: id,
        rootPath: z.string().trim().min(1).max(4096),
        gitRemoteUrl: z.string().trim().min(1).max(2048).optional(),
        defaultBranch: z.string().trim().min(1).max(255).optional(),
      })
      .strict(),
  ),
  'projects.resolve': op(
    'projects',
    false,
    false,
    z
      .object({
        checkoutPath: z.string().trim().min(1).max(4096).optional(),
        gitRemoteUrl: z.string().trim().min(1).max(2048).optional(),
      })
      .strict(),
  ),
  'notes.create': op(
    'context',
    true,
    false,
    z
      .object({
        title,
        body: text,
        projectId: id.optional(),
        source: z.string().max(2000).optional(),
      })
      .strict(),
  ),
  'notes.get': op('context', false, false, readId),
  'notes.update': op(
    'context',
    true,
    false,
    z
      .object({
        id,
        revision,
        body: text,
        title: title.optional(),
        source: z.string().max(2000).nullable().optional(),
      })
      .strict(),
  ),
  'notes.search': op(
    'context',
    false,
    false,
    z.object({ query: z.string().min(1).max(500), ...page }).strict(),
  ),
  'context.search': op(
    'context',
    false,
    false,
    z
      .object({
        query: z.string().trim().min(1).max(500),
        domains: z.array(searchDomainSchema).min(1).max(4).optional(),
        projectId: id.optional(),
        limit: z.number().int().min(1).max(50).default(20),
        includeDeleted: z.boolean().default(false),
      })
      .strict(),
  ),
  'context.packet': op(
    'context',
    true,
    false,
    z
      .object({
        noteIds: z.array(id).max(100),
        maxChars: z.number().int().min(1).max(100_000).default(8000),
        omitUnavailable: z.boolean().default(false),
      })
      .strict(),
  ),
  'context.packet.get': op('context', false, false, readId),
  'tasks.create': op(
    'planning',
    true,
    false,
    z.object({ title, projectId: id, acceptance: text.default('') }).strict(),
  ),
  'tasks.get': op('planning', false, false, readId),
  'projects.update': op(
    'projects',
    true,
    false,
    z.object({ id, revision, title, instructions: text }).strict(),
  ),
  'projects.delete': op('projects', true, true, remove),
  'projects.restore': op('projects', true, true, remove),
  'notes.list': op(
    'context',
    false,
    false,
    z.object({ ...page, includeDeleted: z.boolean().default(false) }).strict(),
  ),
  'notes.delete': op('context', true, true, remove),
  'notes.restore': op('context', true, true, remove),
  'notes.history': op('context', false, false, z.object({ id, ...page }).strict()),
  'tasks.list': op(
    'planning',
    false,
    false,
    z
      .object({ ...page, projectId: id.optional(), includeDeleted: z.boolean().default(false) })
      .strict(),
  ),
  'tasks.update': op(
    'planning',
    true,
    false,
    z
      .object({
        id,
        revision,
        title,
        acceptance: text,
        status: z.enum(['open', 'in_progress', 'done', 'cancelled']),
      })
      .strict(),
  ),
  'tasks.delete': op('planning', true, true, remove),
  'tasks.restore': op('planning', true, true, remove),
  'work.create': op(
    'work',
    true,
    false,
    z
      .object({
        title,
        description: text.default(''),
        rank: z.number().int().min(-1_000_000).max(1_000_000).default(0),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
        labels: z
          .array(z.string().trim().min(1).max(64))
          .max(30)
          .transform((items) => [...new Set(items)])
          .default([]),
        projectId: id.optional(),
        taskId: id.optional(),
        contextIds: z.array(id).max(100).default([]),
        steps: z.array(step).min(1).max(50),
        dependencies: z
          .array(
            z.object({ id, gate: z.enum(['done', 'commands_passed']).default('done') }).strict(),
          )
          .max(100)
          .default([]),
      })
      .strict(),
  ),
  'work.get': op('work', false, false, readId),
  'work.list': op(
    'work',
    false,
    false,
    z.object({ ...page, includeDeleted: z.boolean().default(false) }).strict(),
  ),
  'work.graph': op(
    'work',
    false,
    false,
    z
      .object({
        projectId: id.optional(),
        rootId: id.optional(),
        includeDeleted: z.boolean().default(false),
      })
      .strict(),
  ),
  'work.fork': op(
    'work',
    true,
    false,
    z
      .object({
        id,
        revision,
        reason: title,
        gate: z.enum(['done', 'commands_passed']).default('done'),
        branches: z
          .array(
            z
              .object({
                title,
                description: text.default(''),
                steps: z.array(step).min(1).max(50).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(25),
        claimSecret: z.string().min(32).max(256).optional(),
        epoch: z.number().int().positive().optional(),
      })
      .strict(),
  ),
  'work.claim': op(
    'work',
    true,
    false,
    z
      .object({
        id,
        claimSecret: z.string().min(32).max(256),
        leaseSeconds: z.number().int().min(1).max(3600).default(300),
      })
      .strict(),
  ),
  'work.start': op('work', true, false, z.object(lease).strict()),
  'work.heartbeat': op(
    'work',
    true,
    false,
    z.object({ ...lease, leaseSeconds: z.number().int().min(1).max(3600).default(300) }).strict(),
  ),
  'work.release': op('work', true, false, z.object(lease).strict()),
  'work.review': op('work', true, false, z.object({ ...lease, summary: text }).strict()),
  'work.accept': op('work', true, true, z.object({ id, summary: text }).strict()),
  'work.cancel': op('work', true, true, z.object({ id, reason: title }).strict()),
  'work.plan.revise': op(
    'work',
    true,
    true,
    z.object({ id, steps: z.array(step).min(1).max(50), reason: title }).strict(),
  ),
  'work.evidence': op(
    'work',
    true,
    false,
    z
      .object({
        ...lease,
        planVersion: z.number().int().positive(),
        stepId: id,
        attemptId: z.string().min(1).max(128),
        outcome: z.enum(['passed', 'failed', 'error']),
        output: z.string().max(16_000),
        provenance: z.string().max(4000),
      })
      .strict(),
  ),
  'work.update': op(
    'work',
    true,
    true,
    z
      .object({
        id,
        revision,
        title: title.optional(),
        description: text.optional(),
        steps: z.array(step).min(1).max(50).optional(),
        rank: z.number().int().min(-1_000_000).max(1_000_000).optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        labels: z
          .array(z.string().trim().min(1).max(64))
          .max(30)
          .transform((items) => [...new Set(items)])
          .optional(),
        reason: title,
      })
      .strict()
      .refine(
        (v) =>
          v.title !== undefined ||
          v.description !== undefined ||
          v.steps !== undefined ||
          v.rank !== undefined ||
          v.priority !== undefined ||
          v.labels !== undefined,
        { message: 'At least one mutable field must be provided' },
      ),
  ),
  'work.delete': op('work', true, true, remove),
  'work.restore': op('work', true, true, remove),
  'work.block': op('work', true, false, z.object({ ...lease, reason: title }).strict()),
  'work.fail': op('work', true, false, z.object({ ...lease, reason: title }).strict()),
  'work.requeue': op('work', true, true, z.object({ id, reason: title }).strict()),
  'work.dependencies.set': op(
    'work',
    true,
    true,
    z.object({ id, revision, dependencies: z.array(dependency).max(100), reason: title }).strict(),
  ),
  'work.artifacts.add': op(
    'work',
    true,
    false,
    z
      .object({
        ...lease,
        name: title,
        mediaType: z.string().min(1).max(120),
        content: z.string().max(64000),
      })
      .strict(),
  ),
  'work.artifacts.list': op('work', false, false, z.object({ id, ...page }).strict()),
  'work.artifacts.get': op('work', false, false, z.object({ id, artifactId: id }).strict()),
  'extensions.define': op(
    'extensions',
    true,
    true,
    z
      .object({
        type: key,
        version: z.number().int().positive(),
        schema: z.record(z.string(), z.unknown()),
      })
      .strict(),
  ),
  'objects.create': op(
    'extensions',
    true,
    false,
    z
      .object({
        type: key,
        version: z.number().int().positive(),
        data: z.record(z.string(), z.unknown()),
      })
      .strict(),
  ),
  'objects.get': op('extensions', false, false, readId),
  'objects.list': op(
    'extensions',
    false,
    false,
    z.object({ type: key, ...page, includeDeleted: z.boolean().default(false) }).strict(),
  ),
  'objects.update': op(
    'extensions',
    true,
    false,
    z.object({ id, revision, version: revision, data: z.record(z.string(), z.unknown()) }).strict(),
  ),
  'objects.delete': op('extensions', true, true, remove),
  'objects.restore': op('extensions', true, true, remove),
  'relations.get': op('extensions', false, false, z.object({ id }).strict()),
  'relations.delete': op('extensions', true, false, z.object({ id }).strict()),
  'relations.update': op(
    'extensions',
    true,
    false,
    z.object({ id, type: key, source: ref, target: ref }).strict(),
  ),
  'relations.define': op(
    'extensions',
    true,
    true,
    z.object({ type: key, sourceType: key, targetType: key }).strict(),
  ),
  'relations.create': op(
    'extensions',
    true,
    false,
    z.object({ type: key, source: ref, target: ref }).strict(),
  ),
  'relations.list': op('extensions', false, false, z.object({ id, ...page }).strict()),
} as const;
export type Operation = keyof typeof operations;
export type OperationInput<K extends Operation> = z.input<(typeof operations)[K]['input']>;
export interface Principal {
  id: string;
  ownerId: string;
  scopeId: string | null;
  role: 'owner' | 'agent';
  permissions: string[];
}
export class SiftError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public suggestions?: string[],
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export function allowed(principal: Principal, operation: Operation): boolean {
  const op = operations[operation];
  return (
    (!op.operator || principal.role === 'owner') &&
    (principal.role === 'owner' ||
      principal.permissions.includes(
        `${op.module}:${op.write || operation === 'work.lease' ? 'write' : 'read'}`,
      ))
  );
}
export function canonical(value: unknown): string {
  if (value === undefined) throw new Error('Undefined is not JSON');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}

const DEFAULT_GIT_REMOTE_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'ssh:': '22',
  'git:': '9418',
};

export function normalizeRootPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^\/+$/.test(trimmed)) return '/';
  return trimmed.replace(/\/+$/, '');
}

export function normalizeGitRemoteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  if (!trimmed.includes('://')) {
    const scp = /^(?:([^@/\s]+)@)?([^:/\s][^:/\s]*):(.+)$/.exec(trimmed);
    const host = scp?.[2];
    const pathPart = scp?.[3];
    if (scp && host && pathPart) {
      const hasUser = Boolean(scp[1]);
      const isWindowsDrive = !hasUser && /^[a-zA-Z]$/.test(host) && pathPart.startsWith('\\');
      const isHostWithPort = !hasUser && /^\d+(?:\/|$)/.test(pathPart);
      if (!isWindowsDrive && !isHostWithPort) {
        const cleanPath = pathPart
          .replace(/^\/+/, '')
          .replace(/\/+$/, '')
          .replace(/\.git$/i, '')
          .replace(/\/+$/, '')
          .toLowerCase();
        return cleanPath ? `${host.toLowerCase()}/${cleanPath}` : host.toLowerCase();
      }
    }
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'file:') {
        const filePath = decodeURIComponent(parsed.pathname)
          .replace(/\/+$/, '')
          .replace(/\.git$/i, '')
          .replace(/\/+$/, '')
          .toLowerCase();
        return `file://${filePath || '/'}`;
      }
      const host = parsed.hostname.toLowerCase();
      const defaultPort = DEFAULT_GIT_REMOTE_PORTS[parsed.protocol];
      const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : '';
      const cleanPath = decodeURIComponent(parsed.pathname)
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\.git$/i, '')
        .replace(/\/+$/, '')
        .toLowerCase();
      return cleanPath ? `${host}${port}/${cleanPath}` : `${host}${port}`;
    } catch {
      // Fall through to string normalization when URL parsing fails.
    }
  }

  return trimmed
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}
