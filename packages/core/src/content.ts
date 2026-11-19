import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  operations,
  canonical,
  normalizeRootPath,
  normalizeGitRemoteUrl,
  type Operation,
  type Principal,
} from '@siftable/contracts';
import { setDeleted } from './lifecycle.js';
import { digest } from './database.js';
import { entity, reference, link, first, fail } from './helpers.js';
export async function contentOperation(
  c: PoolClient,
  p: Principal,
  name: Operation,
  input: unknown,
): Promise<unknown> {
  if (
    name === 'projects.delete' ||
    name === 'projects.restore' ||
    name === 'notes.delete' ||
    name === 'notes.restore' ||
    name === 'tasks.delete' ||
    name === 'tasks.restore'
  ) {
    const a = operations[name].input.parse(input);
    const result = await setDeleted(
      c,
      name.startsWith('projects.') ? 'projects' : name.startsWith('notes.') ? 'notes' : 'tasks',
      a,
      name.endsWith('.restore'),
    );
    if (name.startsWith('notes.'))
      await c.query(
        'INSERT INTO context.revisions(id,owner_id,scope_id,note_id,revision,body,title,source) SELECT $1,owner_id,scope_id,id,revision,body,title,source FROM context.notes WHERE id=$2',
        [randomUUID(), a.id],
      );
    return { ...result, deleted: name.endsWith('.delete') };
  }
  if (name === 'projects.update') {
    const a = operations[name].input.parse(input);
    await reference(c, a.id, 'projects.project');
    const r = await c.query(
      'UPDATE projects.projects SET title=$3,instructions=$4,revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING id,title,instructions,revision',
      [a.id, a.revision, a.title, a.instructions],
    );
    if (!r.rowCount) fail(409, 'revision_conflict', 'Project revision changed');
    return r.rows[0];
  }
  if (name === 'tasks.update') {
    const a = operations[name].input.parse(input);
    await reference(c, a.id, 'planning.task');
    const r = await c.query(
      'UPDATE planning.tasks SET title=$3,acceptance=$4,status=$5,revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING id,project_id,title,acceptance,status,revision',
      [a.id, a.revision, a.title, a.acceptance, a.status],
    );
    if (!r.rowCount) fail(409, 'revision_conflict', 'Task revision changed');
    return r.rows[0];
  }
  if (name === 'tasks.list' || name === 'notes.list') {
    const a = operations[name].input.parse(input);
    const table = name === 'tasks.list' ? 'planning.tasks' : 'context.notes';
    const projectId = 'projectId' in a ? a.projectId : undefined;
    return (
      await c.query(
        `SELECT r.*,e.deleted_at FROM ${table} r JOIN foundation.entities e USING(id) WHERE ($3 OR e.deleted_at IS NULL) ${name === 'tasks.list' ? 'AND ($4::uuid IS NULL OR r.project_id=$4)' : ''} ORDER BY r.created_at,r.id LIMIT $1 OFFSET $2`,
        name === 'tasks.list'
          ? [a.limit, a.offset, a.includeDeleted, projectId ?? null]
          : [a.limit, a.offset, a.includeDeleted],
      )
    ).rows;
  }
  if (name === 'notes.history') {
    const a = operations[name].input.parse(input);
    return (
      await c.query(
        'SELECT revision,body,title,source,created_at FROM context.revisions WHERE note_id=$1 ORDER BY revision LIMIT $2 OFFSET $3',
        [a.id, a.limit, a.offset],
      )
    ).rows;
  }
  if (name === 'projects.create') {
    const a = operations[name].input.parse(input);
    const id = await entity(c, p, 'projects.project');
    await c.query(
      'INSERT INTO projects.projects(id,owner_id,scope_id,title,instructions) VALUES($1,$2,$3,$4,$5)',
      [id, p.ownerId, p.scopeId, a.title, a.instructions],
    );
    return { id, ...a, revision: 1 };
  }
  if (name === 'projects.get') {
    const a = operations[name].input.parse(input);
    return first(
      (
        await c.query(
          'SELECT r.id,title,instructions,revision,e.deleted_at FROM projects.projects r JOIN foundation.entities e USING(id) WHERE r.id=$1 AND ($2 OR e.deleted_at IS NULL)',
          [a.id, a.includeDeleted],
        )
      ).rows,
    );
  }
  if (name === 'projects.list') {
    const a = operations[name].input.parse(input);
    return (
      await c.query(
        'SELECT r.id,title,instructions,revision,e.deleted_at FROM projects.projects r JOIN foundation.entities e USING(id) WHERE ($3 OR e.deleted_at IS NULL) ORDER BY r.created_at,r.id LIMIT $1 OFFSET $2',
        [a.limit, a.offset, a.includeDeleted],
      )
    ).rows;
  }
  if (name === 'projects.bind') {
    const a = operations[name].input.parse(input);
    await reference(c, a.projectId, 'projects.project');
    const rootPath = normalizeRootPath(a.rootPath);
    const gitRemoteUrl = a.gitRemoteUrl ? normalizeGitRemoteUrl(a.gitRemoteUrl) : null;
    const defaultBranch = a.defaultBranch ?? null;
    const row = first(
      (
        await c.query<{
          id: string;
          project_id: string;
          root_path: string;
          git_remote_url: string | null;
          default_branch: string | null;
        }>(
          `INSERT INTO projects.bindings(id,owner_id,scope_id,project_id,root_path,git_remote_url,default_branch)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (owner_id,(COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)),root_path)
           DO UPDATE SET project_id=EXCLUDED.project_id,git_remote_url=EXCLUDED.git_remote_url,default_branch=EXCLUDED.default_branch,updated_at=clock_timestamp()
           RETURNING id,project_id,root_path,git_remote_url,default_branch`,
          [randomUUID(), p.ownerId, p.scopeId, a.projectId, rootPath, gitRemoteUrl, defaultBranch],
        )
      ).rows,
    );
    return {
      id: row.id,
      projectId: row.project_id,
      rootPath: row.root_path,
      gitRemoteUrl: row.git_remote_url,
      defaultBranch: row.default_branch,
    };
  }
  if (name === 'projects.resolve') {
    const a = operations[name].input.parse(input);
    const checkoutPath = a.checkoutPath ? normalizeRootPath(a.checkoutPath) : null;
    const gitRemoteUrl = a.gitRemoteUrl ? normalizeGitRemoteUrl(a.gitRemoteUrl) : null;
    if (!checkoutPath && !gitRemoteUrl) {
      return { matched: false, matchKind: null, project: null, binding: null };
    }
    const rows = (
      await c.query<{
        binding_id: string;
        project_id: string;
        root_path: string;
        git_remote_url: string | null;
        default_branch: string | null;
        id: string;
        title: string;
        instructions: string;
        revision: number;
        deleted_at: string | null;
      }>(
        `SELECT b.id AS binding_id,b.project_id,b.root_path,b.git_remote_url,b.default_branch,
                p.id,p.title,p.instructions,p.revision,e.deleted_at
         FROM projects.bindings b
         JOIN projects.projects p ON p.id=b.project_id
         JOIN foundation.entities e ON e.id=p.id
         WHERE e.deleted_at IS NULL
         ORDER BY length(b.root_path) DESC,b.updated_at DESC,b.id ASC`,
      )
    ).rows;
    let matchedRow: (typeof rows)[number] | undefined;
    let matchKind: 'root_path' | 'git_remote' | null = null;
    if (checkoutPath) {
      let bestLength = -1;
      for (const row of rows) {
        const root = normalizeRootPath(row.root_path);
        const matches =
          checkoutPath === root ||
          (root === '/' ? checkoutPath.startsWith('/') : checkoutPath.startsWith(`${root}/`));
        if (matches && root.length > bestLength) {
          bestLength = root.length;
          matchedRow = row;
        }
      }
      if (matchedRow) matchKind = 'root_path';
    }
    if (!matchedRow && gitRemoteUrl) {
      matchedRow = rows.find(
        (row) => row.git_remote_url && normalizeGitRemoteUrl(row.git_remote_url) === gitRemoteUrl,
      );
      if (matchedRow) matchKind = 'git_remote';
    }
    if (!matchedRow || !matchKind) {
      return { matched: false, matchKind: null, project: null, binding: null };
    }
    return {
      matched: true,
      matchKind,
      project: {
        id: matchedRow.id,
        title: matchedRow.title,
        instructions: matchedRow.instructions,
        revision: matchedRow.revision,
        deleted_at: matchedRow.deleted_at,
      },
      binding: {
        id: matchedRow.binding_id,
        projectId: matchedRow.project_id,
        rootPath: matchedRow.root_path,
        gitRemoteUrl: matchedRow.git_remote_url,
        defaultBranch: matchedRow.default_branch,
      },
    };
  }
  if (name === 'tasks.create') {
    const a = operations[name].input.parse(input);
    await reference(c, a.projectId, 'projects.project');
    const id = await entity(c, p, 'planning.task');
    await c.query(
      'INSERT INTO planning.tasks(id,owner_id,scope_id,project_id,title,acceptance) VALUES($1,$2,$3,$4,$5,$6)',
      [id, p.ownerId, p.scopeId, a.projectId, a.title, a.acceptance],
    );
    return { id, ...a, revision: 1 };
  }
  if (name === 'tasks.get') {
    const a = operations[name].input.parse(input);
    return first(
      (
        await c.query(
          'SELECT r.id,project_id,title,acceptance,status,revision,e.deleted_at FROM planning.tasks r JOIN foundation.entities e USING(id) WHERE r.id=$1 AND ($2 OR e.deleted_at IS NULL)',
          [a.id, a.includeDeleted],
        )
      ).rows,
    );
  }
  if (name === 'notes.create') {
    const a = operations[name].input.parse(input);
    const id = await entity(c, p, 'context.note');
    if (a.projectId) {
      await reference(c, a.projectId, 'projects.project');
      await link(c, p, id, a.projectId, 'belongs_to');
    }
    await c.query(
      'INSERT INTO context.notes(id,owner_id,scope_id,title,body,source) VALUES($1,$2,$3,$4,$5,$6)',
      [id, p.ownerId, p.scopeId, a.title, a.body, a.source ?? null],
    );
    await c.query(
      'INSERT INTO context.revisions(id,owner_id,scope_id,note_id,revision,body,title,source) VALUES($1,$2,$3,$4,1,$5,$6,$7)',
      [randomUUID(), p.ownerId, p.scopeId, id, a.body, a.title, a.source ?? null],
    );
    return { id, ...a, revision: 1 };
  }
  if (name === 'notes.get') {
    const a = operations[name].input.parse(input);
    return first(
      (
        await c.query(
          'SELECT r.id,title,body,source,revision,e.deleted_at FROM context.notes r JOIN foundation.entities e USING(id) WHERE r.id=$1 AND ($2 OR e.deleted_at IS NULL)',
          [a.id, a.includeDeleted],
        )
      ).rows,
    );
  }
  if (name === 'notes.update') {
    const a = operations[name].input.parse(input);
    await reference(c, a.id, 'context.note');
    const updated = await c.query(
      'UPDATE context.notes SET body=$3,title=COALESCE($4,title),source=CASE WHEN $5 THEN $6 ELSE source END,revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING id,title,body,source,revision',
      [a.id, a.revision, a.body, a.title ?? null, a.source !== undefined, a.source ?? null],
    );
    if (!updated.rowCount) fail(409, 'revision_conflict', 'Note is missing or revision changed');
    await c.query(
      'INSERT INTO context.revisions(id,owner_id,scope_id,note_id,revision,body,title,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        randomUUID(),
        p.ownerId,
        p.scopeId,
        a.id,
        a.revision + 1,
        a.body,
        updated.rows[0].title,
        updated.rows[0].source,
      ],
    );
    return updated.rows[0];
  }
  if (name === 'notes.search') {
    const a = operations[name].input.parse(input);
    return (
      await c.query(
        "SELECT id,title,body,revision,source FROM context.notes WHERE id IN (SELECT id FROM foundation.entities WHERE deleted_at IS NULL) AND to_tsvector('english',title || ' ' || body) @@ websearch_to_tsquery('english',$1) ORDER BY ts_rank(to_tsvector('english',title || ' ' || body),websearch_to_tsquery('english',$1)) DESC,id LIMIT $2 OFFSET $3",
        [a.query, a.limit, a.offset],
      )
    ).rows;
  }
  if (name === 'context.packet') {
    const a = operations[name].input.parse(input);
    const items: unknown[] = [];
    const omissions: unknown[] = [];
    let remaining = a.maxChars;
    for (const id of [...new Set(a.noteIds)]) {
      const n = (
        await c.query(
          'SELECT id,title,body,source,revision FROM context.notes WHERE id=$1 AND id IN (SELECT id FROM foundation.entities WHERE deleted_at IS NULL)',
          [id],
        )
      ).rows[0];
      // Do not reveal whether an inaccessible ID exists or include metadata about it.
      if (!n) fail(404, 'not_found', 'A requested source is unavailable');
      const rendered = `${n.title}\n${n.body}`;
      if (rendered.length > remaining) {
        omissions.push({ id, reason: 'character_budget' });
        continue;
      }
      remaining -= rendered.length;
      items.push({
        id,
        revision: n.revision,
        source: n.source,
        text: rendered,
        sha256: digest(rendered),
      });
    }
    const manifest = {
      version: 1,
      unit: 'characters',
      budget: a.maxChars,
      used: a.maxChars - remaining,
      items,
      omissions,
    };
    const id = await entity(c, p, 'context.packet');
    const hash = digest(canonical(manifest));
    await c.query(
      'INSERT INTO context.packets(id,owner_id,scope_id,manifest,digest) VALUES($1,$2,$3,$4,$5)',
      [id, p.ownerId, p.scopeId, JSON.stringify(manifest), hash],
    );
    return { id, manifest, digest: hash };
  }
  if (name === 'context.packet.get') {
    const a = operations[name].input.parse(input);
    const packet = first(
      (await c.query('SELECT id,manifest,digest FROM context.packets WHERE id=$1', [a.id])).rows,
    );
    const sources: { id: string; status: string }[] = [];
    for (const item of packet.manifest.items as { id: string; revision: number }[]) {
      const current = (
        await c.query(
          'SELECT revision FROM context.notes WHERE id=$1 AND id IN (SELECT id FROM foundation.entities WHERE deleted_at IS NULL)',
          [item.id],
        )
      ).rows[0];
      sources.push({
        id: item.id,
        status: !current
          ? 'unavailable'
          : current.revision === item.revision
            ? 'current'
            : 'changed',
      });
    }
    return { ...packet, sources };
  }
  return fail(404, 'unknown_operation', 'Unknown content operation');
}
