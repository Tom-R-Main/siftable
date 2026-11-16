import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { SiftError, type Principal } from '@siftable/contracts';
export const fail = (status: number, code: string, message: string): never => {
  throw new SiftError(status, code, message);
};
export async function enabled(c: PoolClient, module: string): Promise<void> {
  const r = await c.query('SELECT enabled FROM foundation.modules WHERE id=$1', [module]);
  if (!r.rows[0]?.enabled)
    fail(409, 'module_unavailable', `Module ${module} is not installed and enabled`);
}
export async function entity(c: PoolClient, p: Principal, type: string): Promise<string> {
  const id = randomUUID();
  await c.query('INSERT INTO foundation.entities(id,owner_id,scope_id,type) VALUES($1,$2,$3,$4)', [
    id,
    p.ownerId,
    p.scopeId,
    type,
  ]);
  return id;
}
export async function reference(c: PoolClient, id: string, type?: string): Promise<void> {
  const r = await c.query(
    'SELECT e.type,t.module FROM foundation.entities e JOIN foundation.entity_types t ON t.type=e.type WHERE e.id=$1 AND e.deleted_at IS NULL',
    [id],
  );
  if (!r.rows[0] || (type && r.rows[0].type !== type))
    fail(404, 'not_found', 'Referenced record is unavailable');
  await enabled(c, r.rows[0].module);
}
export async function link(
  c: PoolClient,
  p: Principal,
  source: string,
  target: string,
  relation: string,
): Promise<string> {
  await reference(c, source);
  await reference(c, target);
  await c.query(
    `INSERT INTO foundation.module_references(source_module,target_module) SELECT st.module,tt.module FROM foundation.entities s JOIN foundation.entity_types st ON st.type=s.type CROSS JOIN foundation.entities t JOIN foundation.entity_types tt ON tt.type=t.type WHERE s.id=$1 AND t.id=$2 AND st.module<>tt.module ON CONFLICT DO NOTHING`,
    [source, target],
  );
  const id = randomUUID();
  await c.query(
    'INSERT INTO foundation.links(id,owner_id,scope_id,source_id,target_id,relation) VALUES($1,$2,$3,$4,$5,$6)',
    [id, p.ownerId, p.scopeId, source, target, relation],
  );
  return id;
}
export function first<T>(rows: T[]): T {
  if (!rows[0]) return fail(404, 'not_found', 'Record is unavailable');
  return rows[0];
}
