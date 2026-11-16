import type { PoolClient } from 'pg';
import { first, fail, reference } from './helpers.js';

// Tables are a closed registry; request data never becomes a SQL identifier.
export const resources = {
  projects: 'projects.projects',
  notes: 'context.notes',
  tasks: 'planning.tasks',
  objects: 'extensions.objects',
  work: 'work.items',
} as const;
export async function setDeleted(
  c: PoolClient,
  resource: keyof typeof resources,
  a: { id: string; revision: number },
  restore: boolean,
) {
  const table = resources[resource];
  const row = first(
    (
      await c.query(
        `SELECT r.revision,e.deleted_at FROM ${table} r JOIN foundation.entities e USING(id) WHERE r.id=$1 FOR UPDATE OF r,e`,
        [a.id],
      )
    ).rows,
  );
  if (row.revision !== a.revision) fail(409, 'revision_conflict', 'Record revision changed');
  if (Boolean(row.deleted_at) !== restore)
    fail(409, 'invalid_transition', 'Record is already in the requested deletion state');
  if (restore) {
    const refs = (
      await c.query('SELECT target_id FROM foundation.links WHERE source_id=$1', [a.id])
    ).rows;
    for (const ref of refs) await reference(c, ref.target_id);
    if (resource === 'tasks')
      await reference(
        c,
        first((await c.query('SELECT project_id FROM planning.tasks WHERE id=$1', [a.id])).rows)
          .project_id,
        'projects.project',
      );
  } else {
    const links = await c.query(
      'SELECT 1 FROM foundation.links l JOIN foundation.entities e ON e.id=l.source_id WHERE l.target_id=$1 AND e.deleted_at IS NULL LIMIT 1',
      [a.id],
    );
    if (links.rowCount)
      fail(
        409,
        'referenced_record',
        'Remove incoming relationships or delete their source records first',
      );
    if (
      resource === 'projects' &&
      (await c.query("SELECT 1 FROM foundation.modules WHERE id='planning'")).rowCount
    ) {
      if (
        (
          await c.query(
            'SELECT 1 FROM planning.tasks t JOIN foundation.entities e USING(id) WHERE t.project_id=$1 AND e.deleted_at IS NULL LIMIT 1',
            [a.id],
          )
        ).rowCount
      )
        fail(409, 'referenced_record', 'Delete project tasks first');
    }
  }
  await c.query(
    'UPDATE foundation.entities SET deleted_at=CASE WHEN $2 THEN NULL ELSE clock_timestamp() END WHERE id=$1',
    [a.id, restore],
  );
  return first(
    (
      await c.query(`UPDATE ${table} SET revision=revision+1 WHERE id=$1 RETURNING id,revision`, [
        a.id,
      ])
    ).rows,
  );
}
