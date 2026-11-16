import type { Pool, PoolClient } from 'pg';
import {
  allowed,
  canonical,
  operations,
  SiftError,
  type Operation,
  type Principal,
} from '@siftable/contracts';
import { authenticate, digest, transaction, manifests } from './database.js';
import { enabled, fail } from './helpers.js';
import { findInlineAgentWorkSecret } from './secretPolicy.js';
import { workOperation } from './work.js';
import { contentOperation } from './content.js';
import { extensionOperation } from './extensions.js';
export * from './database.js';
export { deriveVerificationCoverage } from './verificationCoverage.js';
export async function catalog(pool: Pool, token: string, profile?: string[]) {
  const principal = await authenticate(pool, token);
  const installed = await pool.query<{ id: string }>(
    'SELECT id FROM foundation.modules WHERE enabled',
  );
  const modules = new Set(installed.rows.map((r) => r.id));
  return Object.entries(operations)
    .filter(
      ([name, op]) =>
        modules.has(op.module) &&
        allowed(principal, name as Operation) &&
        (!profile || profile.includes(op.module)),
    )
    .map(([name, op]) => ({ name, module: op.module, write: op.write }));
}
async function foundationOperation(
  c: PoolClient,
  p: Principal,
  name: Operation,
  input: unknown,
): Promise<unknown> {
  if (name === 'modules.list')
    return (await c.query('SELECT id,version,enabled FROM foundation.modules ORDER BY id')).rows;
  if (name === 'schema.inspect') {
    const types = (
      await c.query(
        'SELECT t.type,t.module FROM foundation.entity_types t JOIN foundation.modules m ON m.id=t.module WHERE m.enabled ORDER BY type',
      )
    ).rows;
    const extension = (
      await c.query("SELECT enabled FROM foundation.modules WHERE id='extensions'")
    ).rows[0];
    return {
      types,
      extensions:
        extension?.enabled && allowed(p, 'objects.list')
          ? (
              await c.query(
                'SELECT type,version,definition FROM extensions.definitions ORDER BY type,version',
              )
            ).rows
          : [],
    };
  }
  if (name === 'modules.set') {
    const a = operations[name].input.parse(input);
    if (a.module === 'foundation') fail(400, 'required_module', 'Foundation cannot be disabled');
    if (!(await c.query('SELECT id FROM foundation.modules WHERE id=$1', [a.module])).rowCount)
      fail(
        409,
        'not_installed',
        'Install module migrations through the local administration CLI first',
      );
    const all = await manifests();
    if (a.enabled) {
      for (const dep of all.find((m) => m.id === a.module)!.requires) await enabled(c, dep);
    } else {
      const current = (
        await c.query<{ id: string }>('SELECT id FROM foundation.modules WHERE enabled')
      ).rows.map((r) => r.id);
      if (all.some((m) => current.includes(m.id) && m.requires.includes(a.module)))
        fail(409, 'module_dependents', 'An enabled module requires this module');
      // This release refuses disabling a module with registered cross-module associations.
      const links = await c.query(
        'SELECT 1 FROM foundation.module_references WHERE source_module=$1 OR target_module=$1 LIMIT 1',
        [a.module],
      );
      if (links.rowCount)
        fail(
          409,
          'module_references',
          'Cross-module links require this module; preserve it until those associations are migrated',
        );
    }
    await c.query('UPDATE foundation.modules SET enabled=$2 WHERE id=$1', [a.module, a.enabled]);
    return { module: a.module, enabled: a.enabled };
  }
  return fail(404, 'unknown_operation', 'Unknown operation');
}
export async function execute(
  pool: Pool,
  token: string,
  name: string,
  input: unknown,
  idempotencyKey?: string,
): Promise<unknown> {
  if (!Object.hasOwn(operations, name))
    throw new SiftError(404, 'unknown_operation', 'Unknown operation');
  const operation = name as Operation;
  const contract = operations[operation];
  const p = await authenticate(pool, token);
  if (!allowed(p, operation))
    fail(403, 'forbidden', 'Credential does not authorize this operation');
  const args = contract.input.parse(input);
  const scrub = { ...args } as Record<string, unknown>;
  delete scrub.claimSecret;
  if (findInlineAgentWorkSecret(scrub))
    fail(
      400,
      'inline_secret',
      'Input appears to contain credential material; use a reference instead',
    );
  if (contract.write && (!idempotencyKey || !idempotencyKey.trim() || idempotencyKey.length > 128))
    fail(400, 'idempotency_required', 'A stable Idempotency-Key is required for mutations');
  return transaction(pool, p, async (c) => {
    await c.query(
      `SELECT pg_advisory_xact_lock${operation === 'modules.set' ? '' : '_shared'}(hashtextextended('siftable-module-state',0))`,
    );
    await enabled(c, contract.module);
    const fingerprint = digest(canonical(args));
    if (contract.write) {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${p.id}:${operation}:${idempotencyKey}`,
      ]);
      const r = (
        await c.query(
          'SELECT fingerprint,result FROM foundation.receipts WHERE principal_id=$1 AND operation=$2 AND key=$3',
          [p.id, operation, idempotencyKey],
        )
      ).rows[0];
      if (r) {
        if (r.fingerprint !== fingerprint)
          fail(
            409,
            'idempotency_conflict',
            'Idempotency key was already used with different input',
          );
        return r.result;
      }
    }
    const result =
      contract.module === 'foundation'
        ? await foundationOperation(c, p, operation, args)
        : contract.module === 'work'
          ? await workOperation(c, p, operation, args)
          : contract.module === 'extensions'
            ? await extensionOperation(c, p, operation, args)
            : await contentOperation(c, p, operation, args);
    if (contract.write) {
      await c.query(
        'INSERT INTO foundation.receipts(principal_id,owner_id,scope_id,operation,key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          p.id,
          p.ownerId,
          p.scopeId,
          operation,
          idempotencyKey,
          fingerprint,
          JSON.stringify(result),
        ],
      );
      await c.query(
        'INSERT INTO foundation.audit(owner_id,scope_id,principal_id,operation) VALUES($1,$2,$3,$4)',
        [p.ownerId, p.scopeId, p.id, operation],
      );
    }
    return result;
  });
}
