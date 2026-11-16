import { Ajv, type AnySchema } from 'ajv';
import type { PoolClient } from 'pg';
import {
  operations,
  moduleIds,
  canonical,
  type Operation,
  type Principal,
} from '@siftable/contracts';
import { entity, reference, link, first, fail, enabled } from './helpers.js';
const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
const keywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'description',
  'title',
]);
function safeSchema(schema: Record<string, unknown>, depth = 0): void {
  if (depth > 8 || JSON.stringify(schema).length > 20_000)
    fail(400, 'schema_limit', 'Schema exceeds supported size/depth');
  for (const [k, v] of Object.entries(schema)) {
    if (!keywords.has(k)) fail(400, 'schema_keyword', `Unsupported schema keyword: ${k}`);
    if (k === 'properties') {
      if (!v || typeof v !== 'object' || Array.isArray(v))
        fail(400, 'invalid_schema', 'properties must be an object');
      for (const [field, child] of Object.entries(v as object)) {
        if (
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field) ||
          ['constructor', 'prototype', '__proto__'].includes(field)
        )
          fail(400, 'invalid_field', 'Unsafe property name');
        if (!child || typeof child !== 'object' || Array.isArray(child))
          fail(400, 'invalid_schema', 'Property schemas must be objects');
        safeSchema(child as Record<string, unknown>, depth + 1);
      }
    }
    if (k === 'items' || (k === 'additionalProperties' && typeof v === 'object')) {
      if (!v || typeof v !== 'object' || Array.isArray(v))
        fail(400, 'invalid_schema', 'Nested schema must be an object');
      safeSchema(v as Record<string, unknown>, depth + 1);
    }
  }
}
async function typeExists(c: PoolClient, type: string): Promise<void> {
  const builtin = (
    await c.query('SELECT module FROM foundation.entity_types WHERE type=$1', [type])
  ).rows[0];
  if (builtin) {
    await enabled(c, builtin.module);
    return;
  }
  if (!(await c.query('SELECT 1 FROM extensions.definitions WHERE type=$1', [type])).rowCount)
    fail(400, 'unknown_type', 'Endpoint type is unavailable');
}
async function endpoint(c: PoolClient, id: string, type: string): Promise<void> {
  const custom = (await c.query('SELECT 1 FROM extensions.definitions WHERE type=$1', [type]))
    .rowCount;
  if (custom) {
    await reference(c, id, 'extensions.object');
    if (
      !(await c.query('SELECT 1 FROM extensions.objects WHERE id=$1 AND type=$2', [id, type]))
        .rowCount
    )
      fail(404, 'not_found', 'Endpoint is unavailable');
  } else await reference(c, id, type);
}
export async function extensionOperation(
  c: PoolClient,
  p: Principal,
  name: Operation,
  input: unknown,
): Promise<unknown> {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `extensions:${p.ownerId}:${p.scopeId ?? 'personal'}`,
  ]);
  if (name === 'extensions.define') {
    const a = operations[name].input.parse(input);
    if (moduleIds.some((prefix) => a.type.startsWith(prefix + '.')))
      fail(
        409,
        'reserved_type',
        'Built-in namespaces are reserved even when their modules are absent',
      );
    safeSchema(a.schema);
    if (a.schema.type !== 'object')
      fail(400, 'invalid_schema', 'The root schema must be an object');
    try {
      ajv.compile(a.schema as AnySchema);
    } catch {
      fail(400, 'invalid_schema', 'Schema does not compile under the supported JSON Schema subset');
    }
    if ((await c.query('SELECT 1 FROM foundation.entity_types WHERE type=$1', [a.type])).rowCount)
      fail(409, 'reserved_type', 'Built-in type names are reserved');
    const prior = (
      await c.query(
        'SELECT version,definition FROM extensions.definitions WHERE type=$1 ORDER BY version DESC LIMIT 1',
        [a.type],
      )
    ).rows[0];
    if (a.version !== (prior ? prior.version + 1 : 1))
      fail(409, 'schema_version', 'Schema versions must advance by one');
    if (prior) {
      const old = prior.definition as Record<string, unknown>;
      const { properties: oldProperties, ...oldRest } = old;
      const { properties: newProperties, ...newRest } = a.schema;
      if (canonical(oldRest) !== canonical(newRest))
        fail(409, 'breaking_schema', 'Only additive optional properties are supported');
      for (const [k, v] of Object.entries((oldProperties ?? {}) as object))
        if (canonical(v) !== canonical((newProperties as Record<string, unknown>)?.[k] ?? null))
          fail(409, 'breaking_schema', 'Existing property contracts are immutable');
    }
    await c.query(
      'INSERT INTO extensions.definitions(owner_id,scope_id,type,version,definition) VALUES($1,$2,$3,$4,$5)',
      [p.ownerId, p.scopeId, a.type, a.version, JSON.stringify(a.schema)],
    );
    return { type: a.type, version: a.version };
  }
  if (name === 'objects.create') {
    const a = operations[name].input.parse(input);
    const def = first(
      (
        await c.query(
          'SELECT definition FROM extensions.definitions WHERE type=$1 AND version=$2',
          [a.type, a.version],
        )
      ).rows,
    );
    const validate = ajv.compile(def.definition as AnySchema);
    if (!validate(a.data)) fail(400, 'invalid_record', 'Record violates its declared schema');
    const id = await entity(c, p, 'extensions.object');
    await c.query(
      'INSERT INTO extensions.objects(id,owner_id,scope_id,type,version,data) VALUES($1,$2,$3,$4,$5,$6)',
      [id, p.ownerId, p.scopeId, a.type, a.version, JSON.stringify(a.data)],
    );
    return { id, ...a };
  }
  if (name === 'objects.get') {
    const a = operations[name].input.parse(input);
    return first(
      (await c.query('SELECT id,type,version,data FROM extensions.objects WHERE id=$1', [a.id]))
        .rows,
    );
  }
  if (name === 'objects.list') {
    const a = operations[name].input.parse(input);
    return (
      await c.query(
        'SELECT id,type,version,data FROM extensions.objects WHERE type=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3',
        [a.type, a.limit, a.offset],
      )
    ).rows;
  }
  if (name === 'relations.define') {
    const a = operations[name].input.parse(input);
    await typeExists(c, a.sourceType);
    await typeExists(c, a.targetType);
    await c.query(
      "INSERT INTO foundation.module_references(source_module,target_module) SELECT 'extensions',module FROM foundation.entity_types WHERE type=ANY($1::text[]) AND module<>'extensions' ON CONFLICT DO NOTHING",
      [[a.sourceType, a.targetType]],
    );
    await c.query(
      'INSERT INTO extensions.relations(owner_id,scope_id,type,source_type,target_type) VALUES($1,$2,$3,$4,$5)',
      [p.ownerId, p.scopeId, a.type, a.sourceType, a.targetType],
    );
    return a;
  }
  if (name === 'relations.create') {
    const a = operations[name].input.parse(input);
    const def = first(
      (await c.query('SELECT * FROM extensions.relations WHERE type=$1', [a.type])).rows,
    );
    if (def.source_type !== a.source.type || def.target_type !== a.target.type)
      fail(400, 'endpoint_type', 'Relationship endpoint types do not match');
    await endpoint(c, a.source.id, a.source.type);
    await endpoint(c, a.target.id, a.target.type);
    const id = await link(c, p, a.source.id, a.target.id, a.type);
    return { id, ...a };
  }
  if (name === 'relations.list') {
    const a = operations[name].input.parse(input);
    await reference(c, a.id);
    return (
      await c.query(
        'SELECT id,source_id,target_id,relation FROM foundation.links WHERE source_id=$1 OR target_id=$1 ORDER BY id LIMIT $2 OFFSET $3',
        [a.id, a.limit, a.offset],
      )
    ).rows;
  }
  return fail(404, 'unknown_operation', 'Unknown extension operation');
}
