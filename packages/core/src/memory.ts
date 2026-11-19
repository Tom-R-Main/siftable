import type { PoolClient } from 'pg';
import {
  canonical,
  operations,
  type MemoryKind,
  type MemoryStatus,
  type Operation,
  type Principal,
} from '@siftable/contracts';
import { buildPrefixTsQuery } from './content.js';
import { digest } from './database.js';
import { entity, fail, first, reference } from './helpers.js';
import { findInlineAgentWorkSecret } from './secretPolicy.js';

const HEX_COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const CODE_STATEMENT_LINE_RE =
  /^\s*(?:export\s+|import\s+|function\s+|async\s+function\s+|const\s+|let\s+|var\s+|class\s+|interface\s+|type\s+|def\s+|fn\s+|pub\s+|CREATE\s+TABLE|SELECT\s+|return\s+|if\s*\(|for\s*\(|while\s*\()/;

export const DEFAULT_MEMORY_SEARCH_STATUSES: readonly MemoryStatus[] = [
  'confirmed',
  'unreviewed',
  'needs_review',
];

export const LIFECYCLE_BOOST: Record<MemoryStatus, number> = {
  confirmed: 1.35,
  unreviewed: 1.0,
  needs_review: 0.65,
  rejected: 0.1,
  superseded: 0.1,
};

export interface MemoryEntryRecord {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  kind: MemoryKind;
  status: MemoryStatus;
  paths: string[];
  symbols: string[];
  sourceCommit: string | null;
  fileHashes: Record<string, string>;
  factHash: string;
  supersededBy: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  eventCount?: number;
}

export interface MemoryEventRecord {
  id: number;
  memoryId: string;
  actor: string;
  event: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface MemorySearchItem extends MemoryEntryRecord {
  score: number;
  ftsRank: number;
  pathProximityBoost: number;
  lifecycleBoost: number;
}

export interface MemorySearchResult {
  query: string;
  matchMode: 'fts' | 'prefix_fallback';
  items: MemorySearchItem[];
}

export interface StaleMemoryEntry {
  id: string;
  title: string;
  previousStatus: MemoryStatus;
  newStatus: MemoryStatus;
  changedPaths: string[];
  reasons: string[];
}

export interface DetectStaleResult {
  checked: number;
  staleCount: number;
  dryRun: boolean;
  stale: StaleMemoryEntry[];
}

interface RawMemoryRow {
  id: string;
  project_id: string;
  title: string;
  summary: string;
  kind: MemoryKind;
  status: MemoryStatus;
  paths: string[];
  symbols: string[];
  source_commit: string | null;
  file_hashes: Record<string, string> | null;
  fact_hash: string;
  superseded_by: string | null;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function formatEntry(row: RawMemoryRow, eventCount?: number): MemoryEntryRecord {
  const formatted: MemoryEntryRecord = {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    summary: row.summary,
    kind: row.kind,
    status: row.status,
    paths: Array.isArray(row.paths) ? row.paths : [],
    symbols: Array.isArray(row.symbols) ? row.symbols : [],
    sourceCommit: row.source_commit,
    fileHashes:
      row.file_hashes && typeof row.file_hashes === 'object' && !Array.isArray(row.file_hashes)
        ? row.file_hashes
        : {},
    factHash: row.fact_hash,
    supersededBy: row.superseded_by,
    revision: Number(row.revision),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
  if (eventCount !== undefined) formatted.eventCount = eventCount;
  return formatted;
}

/** Normalize a repo-relative POSIX path; returns null if absolute, empty, or traversing. */
export function normalizeMemoryPath(raw: string): string | null {
  const trimmed = raw.trim().replaceAll('\\', '/');
  if (!trimmed || CONTROL_CHAR_RE.test(trimmed)) return null;
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return null;
  const stripped = trimmed
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  if (!stripped) return null;
  const segments = stripped.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return null;
  return segments.join('/');
}

/** Check whether a commit string is a valid 7-40 character hexadecimal git commit SHA. */
export function isValidSourceCommit(commit: string | null | undefined): boolean {
  return typeof commit === 'string' && HEX_COMMIT_RE.test(commit.trim());
}

/** Reject fenced code blocks, long dumps, and dense multi-line source pastes. */
export function looksLikeRawCodeDump(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > 1200) return true;
  if ((trimmed.match(/```/g) ?? []).length >= 2) return true;
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length >= 8) return true;
  const codePunctuation = (trimmed.match(/[{};]/g) ?? []).length;
  if (lines.length >= 4 && codePunctuation >= 8) return true;
  const codeLines = lines.filter((line) => CODE_STATEMENT_LINE_RE.test(line)).length;
  if (lines.length >= 3 && codeLines >= 3) return true;
  return false;
}

/** Compute a deterministic SHA-256 deduplication hash from normalized fact content and paths. */
export function computeFactHash(input: {
  kind?: string;
  title: string;
  summary: string;
  paths?: readonly string[];
}): string {
  const normalizeText = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const normalizedPaths = [
    ...new Set(
      (input.paths ?? []).map((p) => normalizeMemoryPath(p)).filter((p): p is string => p !== null),
    ),
  ].sort();
  return digest(
    canonical({
      kind: normalizeText(input.kind ?? ''),
      title: normalizeText(input.title),
      summary: normalizeText(input.summary),
      paths: normalizedPaths,
    }),
  );
}

function parentDirectory(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

function sharedDirectoryDepth(a: string, b: string): number {
  const aDirs = parentDirectory(a).split('/').filter(Boolean);
  const bDirs = parentDirectory(b).split('/').filter(Boolean);
  const limit = Math.min(aDirs.length, bDirs.length);
  let depth = 0;
  for (let i = 0; i < limit; i++) {
    if (aDirs[i] !== bDirs[i]) break;
    depth++;
  }
  return depth;
}

function singlePathProximity(entryPath: string, queryPath: string): number {
  if (entryPath === queryPath) return 2.0;
  if (entryPath.startsWith(`${queryPath}/`) || queryPath.startsWith(`${entryPath}/`)) return 1.5;
  const entryDir = parentDirectory(entryPath);
  const queryDir = parentDirectory(queryPath);
  if (entryDir && entryDir === queryDir) return 1.5;
  const shared = sharedDirectoryDepth(entryPath, queryPath);
  if (shared >= 1) return 1.2 + Math.min(shared - 1, 3) * 0.05;
  return 1.0;
}

/**
 * Compute path-proximity multiplier across entry paths and query target paths:
 * exact match (2.0) > same directory / prefix (1.5) > shared parent directory (1.2-1.35) > none (1.0).
 */
export function pathProximityBoost(
  entryPaths: readonly string[],
  queryPaths?: readonly string[],
): number {
  if (!queryPaths?.length || !entryPaths.length) return 1.0;
  const normalizedEntry = entryPaths
    .map((p) => normalizeMemoryPath(p))
    .filter((p): p is string => p !== null);
  const normalizedQuery = queryPaths
    .map((p) => normalizeMemoryPath(p))
    .filter((p): p is string => p !== null);
  if (!normalizedEntry.length || !normalizedQuery.length) return 1.0;
  let best = 1.0;
  for (const ep of normalizedEntry) {
    for (const qp of normalizedQuery) {
      const score = singlePathProximity(ep, qp);
      if (score > best) best = score;
    }
  }
  return best;
}

/** Lifecycle status multiplier: confirmed > unreviewed > needs_review > rejected/superseded. */
export function lifecycleBoost(status: MemoryStatus): number {
  return LIFECYCLE_BOOST[status];
}

function commitsMatch(storedCommit: string, observedCommit: string): boolean {
  const a = storedCommit.trim().toLowerCase();
  const b = observedCommit.trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Pure staleness comparator used by memory.detect_stale and unit tests. */
export function evaluateMemoryStaleness(
  entry: {
    paths: readonly string[];
    sourceCommit: string | null;
    fileHashes: Record<string, string>;
  },
  observed: {
    pathCommits?: Record<string, string | null>;
    fileHashes?: Record<string, string | null>;
  },
): { stale: boolean; changedPaths: string[]; reasons: string[] } {
  const changedPaths = new Set<string>();
  const reasons = new Set<string>();

  if (observed.pathCommits && entry.sourceCommit) {
    for (const rawPath of entry.paths) {
      const path = normalizeMemoryPath(rawPath);
      if (!path || !Object.hasOwn(observed.pathCommits, path)) continue;
      const currentCommit = observed.pathCommits[path];
      if (currentCommit === undefined) continue;
      if (currentCommit === null) {
        changedPaths.add(path);
        reasons.add(`path_missing_in_git:${path}`);
      } else if (!commitsMatch(entry.sourceCommit, currentCommit)) {
        changedPaths.add(path);
        reasons.add(`commit_changed:${path}`);
      }
    }
  }

  if (observed.fileHashes) {
    for (const [rawPath, storedHash] of Object.entries(entry.fileHashes)) {
      const path = normalizeMemoryPath(rawPath);
      if (!path || !Object.hasOwn(observed.fileHashes, path)) continue;
      const currentHash = observed.fileHashes[path];
      if (currentHash === undefined) continue;
      if (currentHash === null) {
        changedPaths.add(path);
        reasons.add(`file_deleted:${path}`);
      } else if (currentHash.toLowerCase() !== storedHash.toLowerCase()) {
        changedPaths.add(path);
        reasons.add(`file_hash_changed:${path}`);
      }
    }
    for (const rawPath of entry.paths) {
      const path = normalizeMemoryPath(rawPath);
      if (!path || !Object.hasOwn(observed.fileHashes, path)) continue;
      if (observed.fileHashes[path] === null) {
        changedPaths.add(path);
        reasons.add(`file_deleted:${path}`);
      }
    }
  }

  return {
    stale: changedPaths.size > 0,
    changedPaths: [...changedPaths].sort(),
    reasons: [...reasons].sort(),
  };
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

async function appendEvent(
  c: PoolClient,
  p: Principal,
  memoryId: string,
  event: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await c.query(
    'INSERT INTO memory.events(owner_id,scope_id,memory_id,actor,event,detail) VALUES($1,$2,$3,$4,$5,$6)',
    [p.ownerId, p.scopeId, memoryId, p.id, event, JSON.stringify(detail)],
  );
}

export async function memoryOperation(
  c: PoolClient,
  p: Principal,
  name: Operation,
  input: unknown,
): Promise<unknown> {
  if (name === 'memory.store') {
    const a = operations[name].input.parse(input);
    await reference(c, a.projectId, 'projects.project');

    if (
      findInlineAgentWorkSecret(
        {
          title: a.title,
          summary: a.summary,
          paths: a.paths,
          symbols: a.symbols,
          fileHashEntries: Object.entries(a.fileHashes),
        },
        'memory',
      )
    ) {
      fail(
        400,
        'secret_detected',
        'Code memory refused: input appears to contain credential material',
      );
    }

    if (looksLikeRawCodeDump(a.title) || looksLikeRawCodeDump(a.summary)) {
      fail(
        400,
        'raw_code_dump',
        'Code memory refused: content looks like a raw code dump; store a concise durable fact instead',
      );
    }

    const normalizedPathSet = new Set<string>();
    for (const rawPath of a.paths) {
      const normalized = normalizeMemoryPath(rawPath);
      if (!normalized) {
        return fail(
          400,
          'provenance_required',
          'Code memory paths must be normalized repository-relative paths',
        );
      }
      normalizedPathSet.add(normalized);
    }
    const normalizedPaths = [...normalizedPathSet].sort();

    const normalizedSymbols = [...new Set(a.symbols.map((s) => s.trim()).filter(Boolean))].sort();

    let normalizedCommit: string | null = null;
    if (a.sourceCommit !== undefined) {
      if (!isValidSourceCommit(a.sourceCommit)) {
        return fail(
          400,
          'provenance_required',
          'sourceCommit must be a valid 7-40 character hexadecimal git commit SHA',
        );
      }
      normalizedCommit = a.sourceCommit.trim().toLowerCase();
    }

    if (p.role === 'agent' && (normalizedPaths.length === 0 || !normalizedCommit)) {
      return fail(
        400,
        'provenance_required',
        'Agent code memory stores require at least one normalized relative path and a valid sourceCommit (7-40 hex chars)',
      );
    }

    const normalizedFileHashes: Record<string, string> = {};
    for (const [rawPath, sha] of Object.entries(a.fileHashes)) {
      const normalized = normalizeMemoryPath(rawPath);
      if (!normalized) {
        return fail(
          400,
          'provenance_required',
          'fileHashes keys must be normalized repository-relative paths',
        );
      }
      if (!SHA256_HEX_RE.test(sha)) {
        return fail(
          400,
          'invalid_input',
          'fileHashes values must be 64-character SHA-256 hex digests',
        );
      }
      normalizedFileHashes[normalized] = sha.toLowerCase();
    }

    const factHash = computeFactHash({
      kind: a.kind,
      title: a.title,
      summary: a.summary,
      paths: normalizedPaths,
    });

    let supersededEntry: RawMemoryRow | undefined;
    if (a.supersedesId) {
      const foundSuperseded = (
        await c.query<RawMemoryRow>(
          `SELECT m.*, e.deleted_at
           FROM memory.entries m
           JOIN foundation.entities e USING (id)
           WHERE m.id = $1 AND e.deleted_at IS NULL
           FOR UPDATE OF m, e`,
          [a.supersedesId],
        )
      ).rows[0];
      if (!foundSuperseded) {
        return fail(404, 'not_found', 'Superseded memory entry is unavailable');
      }
      if (foundSuperseded.project_id !== a.projectId) {
        return fail(
          400,
          'project_mismatch',
          'Superseded memory entry belongs to a different project',
        );
      }
      if (foundSuperseded.status === 'superseded' || foundSuperseded.status === 'rejected') {
        return fail(
          409,
          'invalid_transition',
          'Cannot supersede a rejected or already superseded memory entry',
        );
      }
      supersededEntry = foundSuperseded;
    }

    const existing = (
      await c.query<RawMemoryRow>(
        `SELECT m.*, e.deleted_at
         FROM memory.entries m
         JOIN foundation.entities e USING (id)
         WHERE m.project_id = $1
           AND m.fact_hash = $2
           AND m.status NOT IN ('rejected', 'superseded')
           AND ($3::uuid IS NULL OR m.id <> $3::uuid)
         LIMIT 1`,
        [a.projectId, factHash, a.supersedesId ?? null],
      )
    ).rows[0];

    if (existing) {
      if (existing.deleted_at !== null) {
        fail(
          409,
          'duplicate_deleted',
          'A deleted active memory entry already occupies this fact hash',
        );
      }
      return { ...formatEntry(existing), deduplicated: true };
    }

    const initialStatus: MemoryStatus = p.role === 'owner' ? 'confirmed' : 'unreviewed';
    const newId = await entity(c, p, 'memory.entry');

    if (supersededEntry) {
      await c.query(
        `UPDATE memory.entries
         SET status = 'superseded', revision = revision + 1, updated_at = clock_timestamp()
         WHERE id = $1`,
        [supersededEntry.id],
      );
    }

    const inserted = first(
      (
        await c.query<RawMemoryRow>(
          `INSERT INTO memory.entries (
             id, owner_id, scope_id, project_id, title, summary, kind, status,
             paths, symbols, source_commit, file_hashes, fact_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
           RETURNING *, NULL::timestamptz AS deleted_at`,
          [
            newId,
            p.ownerId,
            p.scopeId,
            a.projectId,
            a.title,
            a.summary,
            a.kind,
            initialStatus,
            normalizedPaths,
            normalizedSymbols,
            normalizedCommit,
            JSON.stringify(normalizedFileHashes),
            factHash,
          ],
        )
      ).rows,
    );

    if (supersededEntry) {
      await c.query('UPDATE memory.entries SET superseded_by = $2 WHERE id = $1', [
        supersededEntry.id,
        newId,
      ]);
      await appendEvent(c, p, supersededEntry.id, 'memory.superseded', {
        previousStatus: supersededEntry.status,
        newStatus: 'superseded',
        supersededBy: newId,
      });
    }

    await appendEvent(c, p, newId, 'memory.stored', {
      status: initialStatus,
      kind: a.kind,
      paths: normalizedPaths,
      sourceCommit: normalizedCommit,
      supersedesId: supersededEntry?.id ?? null,
    });

    return { ...formatEntry(inserted), deduplicated: false };
  }

  if (name === 'memory.get') {
    const a = operations[name].input.parse(input);
    const row = first(
      (
        await c.query<RawMemoryRow>(
          `SELECT m.*, e.deleted_at
           FROM memory.entries m
           JOIN foundation.entities e USING (id)
           WHERE m.id = $1 AND ($2 OR e.deleted_at IS NULL)`,
          [a.id, a.includeDeleted],
        )
      ).rows,
    );
    if (!a.includeEventCount) return formatEntry(row);
    const count = (
      await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM memory.events WHERE memory_id = $1',
        [a.id],
      )
    ).rows[0]?.n;
    return formatEntry(row, count ?? 0);
  }

  if (name === 'memory.list') {
    const a = operations[name].input.parse(input);
    let normalizedPrefix: string | null = null;
    let likePattern: string | null = null;
    if (a.pathPrefix !== undefined) {
      const parsedPrefix = normalizeMemoryPath(a.pathPrefix);
      if (!parsedPrefix) {
        return fail(
          400,
          'invalid_input',
          'pathPrefix must be a normalized repository-relative path',
        );
      }
      normalizedPrefix = parsedPrefix;
      likePattern = `${escapeLike(parsedPrefix)}/%`;
    }
    const rows = (
      await c.query<RawMemoryRow>(
        `SELECT m.*, e.deleted_at
         FROM memory.entries m
         JOIN foundation.entities e USING (id)
         WHERE ($3::boolean OR e.deleted_at IS NULL)
           AND ($4::uuid IS NULL OR m.project_id = $4::uuid)
           AND ($5::text IS NULL OR m.status = $5::text)
           AND ($6::text IS NULL OR m.kind = $6::text)
           AND (
             $7::text IS NULL
             OR EXISTS (
               SELECT 1
               FROM unnest(m.paths) AS p
               WHERE p = $7::text OR p LIKE $8::text ESCAPE '\\'
             )
           )
         ORDER BY m.updated_at DESC, m.id ASC
         LIMIT $1 OFFSET $2`,
        [
          a.limit,
          a.offset,
          a.includeDeleted,
          a.projectId ?? null,
          a.status ?? null,
          a.kind ?? null,
          normalizedPrefix,
          likePattern,
        ],
      )
    ).rows;
    return rows.map((row) => formatEntry(row));
  }

  if (name === 'memory.search') {
    const a = operations[name].input.parse(input);
    const statuses = [...new Set(a.statuses ?? DEFAULT_MEMORY_SEARCH_STATUSES)];
    const queryPaths = (a.paths ?? [])
      .map((raw) => normalizeMemoryPath(raw))
      .filter((p): p is string => p !== null);
    const candidateLimit = Math.min(Math.max(a.limit * 5, 100), 500);

    interface SearchRow extends RawMemoryRow {
      fts_rank: number;
    }

    const runSearch = async (queryExpr: string, queryText: string): Promise<SearchRow[]> =>
      (
        await c.query<SearchRow>(
          `WITH q AS (
             SELECT ${queryExpr} AS query
           )
           SELECT
             m.*,
             e.deleted_at,
             ts_rank_cd(to_tsvector('english', m.title || ' ' || m.summary), q.query)::double precision AS fts_rank
           FROM memory.entries m
           CROSS JOIN q
           JOIN foundation.entities e USING (id)
           WHERE ($5::boolean OR e.deleted_at IS NULL)
             AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
             AND ($3::text IS NULL OR m.kind = $3::text)
             AND m.status = ANY($4::text[])
             AND to_tsvector('english', m.title || ' ' || m.summary) @@ q.query
           ORDER BY fts_rank DESC, m.updated_at DESC, m.id ASC
           LIMIT $6`,
          [
            queryText,
            a.projectId ?? null,
            a.kind ?? null,
            statuses,
            a.includeDeleted,
            candidateLimit,
          ],
        )
      ).rows;

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

    const ranked: MemorySearchItem[] = rows
      .map((row) => {
        const entry = formatEntry(row);
        const ftsRank = Number(row.fts_rank);
        const proximity = pathProximityBoost(entry.paths, queryPaths);
        const statusBoost = lifecycleBoost(entry.status);
        const score = ftsRank * proximity * statusBoost;
        return {
          ...entry,
          score,
          ftsRank,
          pathProximityBoost: proximity,
          lifecycleBoost: statusBoost,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.pathProximityBoost - left.pathProximityBoost ||
          right.lifecycleBoost - left.lifecycleBoost ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, a.limit);

    return {
      query: a.query,
      matchMode,
      items: ranked,
    } satisfies MemorySearchResult;
  }

  if (name === 'memory.events') {
    const a = operations[name].input.parse(input);
    const exists = (await c.query('SELECT 1 FROM memory.entries WHERE id = $1', [a.id])).rowCount;
    if (!exists) fail(404, 'not_found', 'Memory entry is unavailable');
    const rows = (
      await c.query<{
        id: string | number;
        memory_id: string;
        actor: string;
        event: string;
        detail: Record<string, unknown>;
        created_at: Date | string;
      }>(
        'SELECT id, memory_id, actor, event, detail, created_at FROM memory.events WHERE memory_id = $1 ORDER BY id ASC LIMIT $2 OFFSET $3',
        [a.id, a.limit, a.offset],
      )
    ).rows;
    return rows.map((row): MemoryEventRecord => ({
      id: Number(row.id),
      memoryId: row.memory_id,
      actor: row.actor,
      event: row.event,
      detail: row.detail,
      createdAt: toIso(row.created_at),
    }));
  }

  if (name === 'memory.mark_needs_review') {
    const a = operations[name].input.parse(input);
    const row = first(
      (
        await c.query<RawMemoryRow>(
          `SELECT m.*, e.deleted_at
           FROM memory.entries m
           JOIN foundation.entities e USING (id)
           WHERE m.id = $1 AND e.deleted_at IS NULL
           FOR UPDATE OF m, e`,
          [a.id],
        )
      ).rows,
    );
    if (row.revision !== a.revision) {
      fail(409, 'revision_conflict', 'Memory entry revision changed');
    }
    if (row.status !== 'unreviewed' && row.status !== 'confirmed') {
      fail(
        409,
        'invalid_transition',
        'Only unreviewed or confirmed memory entries can be marked needs_review',
      );
    }
    const updated = first(
      (
        await c.query<RawMemoryRow>(
          `UPDATE memory.entries
           SET status = 'needs_review', revision = revision + 1, updated_at = clock_timestamp()
           WHERE id = $1
           RETURNING *, NULL::timestamptz AS deleted_at`,
          [a.id],
        )
      ).rows,
    );
    await appendEvent(c, p, a.id, 'memory.needs_review', {
      previousStatus: row.status,
      newStatus: 'needs_review',
      reason: a.reason,
    });
    return formatEntry(updated);
  }

  if (name === 'memory.review') {
    const a = operations[name].input.parse(input);
    const row = first(
      (
        await c.query<RawMemoryRow>(
          `SELECT m.*, e.deleted_at
           FROM memory.entries m
           JOIN foundation.entities e USING (id)
           WHERE m.id = $1 AND e.deleted_at IS NULL
           FOR UPDATE OF m, e`,
          [a.id],
        )
      ).rows,
    );
    if (row.revision !== a.revision) {
      fail(409, 'revision_conflict', 'Memory entry revision changed');
    }
    if (row.status === 'superseded') {
      fail(409, 'invalid_transition', 'Superseded memory entries cannot be reviewed');
    }
    if (row.status === a.decision) {
      fail(409, 'invalid_transition', 'Memory entry is already in the requested review status');
    }
    const updated = first(
      (
        await c.query<RawMemoryRow>(
          `UPDATE memory.entries
           SET status = $2, revision = revision + 1, updated_at = clock_timestamp()
           WHERE id = $1
           RETURNING *, NULL::timestamptz AS deleted_at`,
          [a.id, a.decision],
        )
      ).rows,
    );
    await appendEvent(
      c,
      p,
      a.id,
      a.decision === 'confirmed' ? 'memory.confirmed' : 'memory.rejected',
      {
        previousStatus: row.status,
        newStatus: a.decision,
        note: a.note,
      },
    );
    return formatEntry(updated);
  }

  if (name === 'memory.detect_stale') {
    const a = operations[name].input.parse(input);
    await reference(c, a.projectId, 'projects.project');

    let normalizedPathCommits: Record<string, string | null> | undefined;
    if (a.pathCommits) {
      normalizedPathCommits = {};
      for (const [rawPath, commit] of Object.entries(a.pathCommits)) {
        const normalized = normalizeMemoryPath(rawPath);
        if (!normalized) {
          return fail(
            400,
            'invalid_input',
            'pathCommits keys must be normalized repository-relative paths',
          );
        }
        if (commit !== null && !isValidSourceCommit(commit)) {
          return fail(
            400,
            'invalid_input',
            'pathCommits values must be null or 7-40 character hexadecimal git commit SHAs',
          );
        }
        normalizedPathCommits[normalized] = commit === null ? null : commit.trim().toLowerCase();
      }
    }

    let normalizedFileHashes: Record<string, string | null> | undefined;
    if (a.fileHashes) {
      normalizedFileHashes = {};
      for (const [rawPath, sha] of Object.entries(a.fileHashes)) {
        const normalized = normalizeMemoryPath(rawPath);
        if (!normalized) {
          return fail(
            400,
            'invalid_input',
            'fileHashes keys must be normalized repository-relative paths',
          );
        }
        if (sha !== null && !SHA256_HEX_RE.test(sha)) {
          return fail(
            400,
            'invalid_input',
            'fileHashes values must be null or 64-character SHA-256 hex digests',
          );
        }
        normalizedFileHashes[normalized] = sha === null ? null : sha.toLowerCase();
      }
    }

    const entries = (
      await c.query<RawMemoryRow>(
        `SELECT m.*, e.deleted_at
         FROM memory.entries m
         JOIN foundation.entities e USING (id)
         WHERE m.project_id = $1
           AND e.deleted_at IS NULL
           AND m.status IN ('unreviewed', 'confirmed')
         ORDER BY m.created_at ASC, m.id ASC${a.dryRun ? '' : ' FOR UPDATE OF m'}`,
        [a.projectId],
      )
    ).rows;

    const stale: StaleMemoryEntry[] = [];
    for (const row of entries) {
      const entry = formatEntry(row);
      const evaluation = evaluateMemoryStaleness(
        {
          paths: entry.paths,
          sourceCommit: entry.sourceCommit,
          fileHashes: entry.fileHashes,
        },
        {
          pathCommits: normalizedPathCommits,
          fileHashes: normalizedFileHashes,
        },
      );
      if (!evaluation.stale) continue;
      if (!a.dryRun) {
        await c.query(
          `UPDATE memory.entries
           SET status = 'needs_review', revision = revision + 1, updated_at = clock_timestamp()
           WHERE id = $1`,
          [entry.id],
        );
        await appendEvent(c, p, entry.id, 'memory.stale_detected', {
          previousStatus: entry.status,
          newStatus: 'needs_review',
          changedPaths: evaluation.changedPaths,
          reasons: evaluation.reasons,
          reason: a.reason ?? 'Detected git commit or file hash drift',
        });
      }
      stale.push({
        id: entry.id,
        title: entry.title,
        previousStatus: entry.status,
        newStatus: a.dryRun ? entry.status : 'needs_review',
        changedPaths: evaluation.changedPaths,
        reasons: evaluation.reasons,
      });
    }

    return {
      checked: entries.length,
      staleCount: stale.length,
      dryRun: a.dryRun,
      stale,
    } satisfies DetectStaleResult;
  }

  if (name === 'memory.delete') {
    const a = operations[name].input.parse(input);
    const row = first(
      (
        await c.query<RawMemoryRow>(
          `SELECT m.*, e.deleted_at
           FROM memory.entries m
           JOIN foundation.entities e USING (id)
           WHERE m.id = $1
           FOR UPDATE OF m, e`,
          [a.id],
        )
      ).rows,
    );
    if (row.revision !== a.revision) {
      fail(409, 'revision_conflict', 'Memory entry revision changed');
    }
    if (row.deleted_at !== null) {
      fail(409, 'invalid_transition', 'Memory entry is already deleted');
    }
    await c.query('UPDATE foundation.entities SET deleted_at = clock_timestamp() WHERE id = $1', [
      a.id,
    ]);
    const updated = first(
      (
        await c.query<{ id: string; revision: number }>(
          'UPDATE memory.entries SET revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING id, revision',
          [a.id],
        )
      ).rows,
    );
    await appendEvent(c, p, a.id, 'memory.deleted', {
      previousStatus: row.status,
      reason: a.reason,
    });
    return { id: updated.id, revision: Number(updated.revision), deleted: true };
  }

  return fail(404, 'unknown_operation', 'Unknown memory operation');
}
