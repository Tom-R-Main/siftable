import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  operations,
  canonical,
  normalizeRootPath,
  normalizeGitRemoteUrl,
  searchDomains,
  type ModuleId,
  type Operation,
  type PacketOmissionType,
  type Principal,
  type SearchDomain,
} from '@siftable/contracts';
import { setDeleted } from './lifecycle.js';
import { digest } from './database.js';
import { entity, reference, link, first, fail } from './helpers.js';

export const RECENCY_DECAY_HALF_LIFE_DAYS = 30;

const DOMAIN_MODULE_MAP: Record<SearchDomain, ModuleId> = {
  note: 'context',
  task: 'planning',
  project: 'projects',
  object: 'extensions',
};

export interface PacketOmission {
  id: string;
  omissionType: PacketOmissionType;
  reason: string;
  requiredChars?: number;
  remainingChars?: number;
}

export interface ScopedPacketCandidate {
  id: string;
  type: string;
  revision: number;
}

export interface ContextSearchItem {
  entityId: string;
  domain: SearchDomain;
  entityType: string;
  projectId: string | null;
  title: string;
  snippet: string;
  score: number;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ContextSearchResult {
  query: string;
  matchMode: 'fts' | 'prefix_fallback';
  items: ContextSearchItem[];
}

export function sanitizeSearchTerms(rawQuery: string): string[] {
  const matches = rawQuery.match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of matches) {
    const normalized = raw.toLowerCase().slice(0, 64);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push(normalized);
    if (terms.length >= 24) break;
  }
  return terms;
}

export function buildPrefixTsQuery(rawQuery: string): string | null {
  const terms = sanitizeSearchTerms(rawQuery);
  if (!terms.length) return null;
  return terms.map((term) => `${term}:*`).join(' & ');
}

export function computeRecencyDecay(
  ageDays: number,
  halfLifeDays = RECENCY_DECAY_HALF_LIFE_DAYS,
): number {
  const clampedAge = Number.isFinite(ageDays) ? Math.max(ageDays, 0) : 0;
  return 1 / (1 + clampedAge / halfLifeDays);
}

export function makeSearchSnippet(body: string, maxChars = 280): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function permittedSearchDomains(
  principal: Principal,
  requested?: readonly SearchDomain[],
): SearchDomain[] {
  const allowedByRole =
    principal.role === 'owner'
      ? [...searchDomains]
      : searchDomains.filter((domain) =>
          principal.permissions.includes(`${DOMAIN_MODULE_MAP[domain]}:read`),
        );
  if (!requested) return allowedByRole;
  const requestedSet = new Set(requested);
  return allowedByRole.filter((domain) => requestedSet.has(domain));
}

export function computeScopedCandidateDigest(candidates: readonly ScopedPacketCandidate[]): string {
  const normalized = candidates
    .map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      revision: candidate.revision,
    }))
    .sort(
      (a, b) => a.id.localeCompare(b.id) || a.type.localeCompare(b.type) || a.revision - b.revision,
    );
  return digest(canonical(normalized));
}
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
  if (name === 'context.search') {
    const a = operations[name].input.parse(input);
    const allowedDomains = permittedSearchDomains(p, a.domains);
    if (!allowedDomains.length) {
      return { query: a.query, matchMode: 'fts', items: [] } satisfies ContextSearchResult;
    }
    interface SearchRow {
      entity_id: string;
      domain: SearchDomain;
      entity_type: string;
      project_id: string | null;
      title: string;
      body: string;
      updated_at: Date | string;
      deleted_at: Date | string | null;
      score: number;
    }
    const runSearch = async (queryExpr: string, queryText: string): Promise<SearchRow[]> =>
      (
        await c.query<SearchRow>(
          `WITH q AS (
             SELECT ${queryExpr} AS query
           )
           SELECT
             idx.entity_id,
             idx.domain,
             idx.entity_type,
             idx.project_id,
             idx.title,
             idx.body,
             idx.updated_at,
             e.deleted_at,
             (
               ts_rank_cd(idx.search_vector, q.query)
               * (1.0 / (1.0 + GREATEST(EXTRACT(EPOCH FROM (now() - idx.updated_at)) / 86400.0, 0.0) / ${RECENCY_DECAY_HALF_LIFE_DAYS}.0))
             )::double precision AS score
           FROM context.index idx
           CROSS JOIN q
           JOIN foundation.entities e ON e.id = idx.entity_id
           JOIN foundation.entity_types et ON et.type = e.type
           JOIN foundation.modules m ON m.id = et.module
           WHERE m.enabled
             AND ($4::boolean OR e.deleted_at IS NULL)
             AND idx.domain = ANY($2::text[])
             AND ($3::uuid IS NULL OR idx.project_id = $3::uuid)
             AND idx.search_vector @@ q.query
           ORDER BY score DESC, idx.updated_at DESC, idx.entity_id ASC
           LIMIT $5`,
          [queryText, allowedDomains, a.projectId ?? null, a.includeDeleted, a.limit],
        )
      ).rows;
    const formatRow = (row: SearchRow): ContextSearchItem => ({
      entityId: row.entity_id,
      domain: row.domain,
      entityType: row.entity_type,
      projectId: row.project_id,
      title: row.title,
      snippet: makeSearchSnippet(row.body),
      score: Number(row.score),
      updatedAt:
        row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      deletedAt:
        row.deleted_at === null
          ? null
          : row.deleted_at instanceof Date
            ? row.deleted_at.toISOString()
            : String(row.deleted_at),
    });
    let matchMode: 'fts' | 'prefix_fallback' = 'fts';
    let rows = await runSearch("websearch_to_tsquery('english', $1)", a.query);
    if (!rows.length) {
      const prefixQuery = buildPrefixTsQuery(a.query);
      if (prefixQuery) {
        const fallbackRows = await runSearch("to_tsquery('english', $1)", prefixQuery);
        if (fallbackRows.length) {
          rows = fallbackRows;
          matchMode = 'prefix_fallback';
        }
      }
    }
    return {
      query: a.query,
      matchMode,
      items: rows.map(formatRow),
    } satisfies ContextSearchResult;
  }
  if (name === 'context.packet') {
    const a = operations[name].input.parse(input);
    const items: unknown[] = [];
    const omissions: PacketOmission[] = [];
    const scopedCandidates: ScopedPacketCandidate[] = [];
    let remaining = a.maxChars;
    for (const id of [...new Set(a.noteIds)]) {
      const n = (
        await c.query<{
          id: string;
          title: string;
          body: string;
          source: string | null;
          revision: number;
          deleted_at: Date | string | null;
        }>(
          'SELECT n.id,n.title,n.body,n.source,n.revision,e.deleted_at FROM context.notes n JOIN foundation.entities e USING(id) WHERE n.id=$1',
          [id],
        )
      ).rows[0];
      // Do not reveal whether an inaccessible ID exists or include metadata about it.
      if (!n) {
        if (!a.omitUnavailable) fail(404, 'not_found', 'A requested source is unavailable');
        omissions.push({ id, omissionType: 'not_found', reason: 'not_found' });
        continue;
      }
      if (n.deleted_at !== null) {
        if (!a.omitUnavailable) fail(404, 'not_found', 'A requested source is unavailable');
        omissions.push({ id, omissionType: 'deleted', reason: 'deleted' });
        continue;
      }
      scopedCandidates.push({ id: n.id, type: 'context.note', revision: n.revision });
      const rendered = `${n.title}\n${n.body}`;
      if (rendered.length > remaining) {
        omissions.push({
          id,
          omissionType: 'budget_exceeded',
          reason: 'character_budget',
          requiredChars: rendered.length,
          remainingChars: remaining,
        });
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
    const scopedCandidateDigest = computeScopedCandidateDigest(scopedCandidates);
    const manifest = {
      version: 1,
      unit: 'characters',
      budget: a.maxChars,
      used: a.maxChars - remaining,
      scopedCandidateDigest,
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
