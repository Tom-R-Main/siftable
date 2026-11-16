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
  'projects.create': op(
    'projects',
    true,
    false,
    z.object({ title, instructions: text.default('') }).strict(),
  ),
  'projects.get': op('projects', false, false, z.object({ id }).strict()),
  'projects.list': op('projects', false, false, z.object(page).strict()),
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
  'notes.get': op('context', false, false, z.object({ id }).strict()),
  'notes.update': op(
    'context',
    true,
    false,
    z.object({ id, revision: z.number().int().positive(), body: text }).strict(),
  ),
  'notes.search': op(
    'context',
    false,
    false,
    z.object({ query: z.string().min(1).max(500), ...page }).strict(),
  ),
  'context.packet': op(
    'context',
    true,
    false,
    z
      .object({
        noteIds: z.array(id).max(100),
        maxChars: z.number().int().min(1).max(100_000).default(8000),
      })
      .strict(),
  ),
  'context.packet.get': op('context', false, false, z.object({ id }).strict()),
  'tasks.create': op(
    'planning',
    true,
    false,
    z.object({ title, projectId: id, acceptance: text.default('') }).strict(),
  ),
  'tasks.get': op('planning', false, false, z.object({ id }).strict()),
  'work.create': op(
    'work',
    true,
    false,
    z
      .object({
        title,
        description: text.default(''),
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
  'work.get': op('work', false, false, z.object({ id }).strict()),
  'work.list': op('work', false, false, z.object(page).strict()),
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
  'objects.get': op('extensions', false, false, z.object({ id }).strict()),
  'objects.list': op('extensions', false, false, z.object({ type: key, ...page }).strict()),
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
  ) {
    super(message);
  }
}
export function allowed(principal: Principal, operation: Operation): boolean {
  const op = operations[operation];
  return (
    (!op.operator || principal.role === 'owner') &&
    (principal.role === 'owner' ||
      principal.permissions.includes(`${op.module}:${op.write ? 'write' : 'read'}`))
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
