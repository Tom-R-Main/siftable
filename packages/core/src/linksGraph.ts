import type { PoolClient } from 'pg';
import { first } from './helpers.js';

export interface LinksGraphInput {
  id: string;
  depth: number;
  maxNodes: number;
  includeDeleted: boolean;
}

export interface LinksGraphNode {
  id: string;
  type: string;
  depth: number;
  deleted: boolean;
}

export interface LinksGraphEdge {
  sourceId: string;
  targetId: string;
  relation: string;
}

export interface LinksGraphResult {
  rootId: string;
  depth: number;
  truncated: boolean;
  nodes: LinksGraphNode[];
  edges: LinksGraphEdge[];
}

export interface RawEntityRecord {
  id: string;
  type: string;
  deleted_at: Date | string | null;
}

export interface RawLinkRecord {
  source_id: string;
  target_id: string;
  relation: string;
}

export function buildBoundedLinksGraph(
  entities: readonly RawEntityRecord[],
  links: readonly RawLinkRecord[],
  input: LinksGraphInput,
): LinksGraphResult | null {
  const depthLimit = Math.max(1, Math.min(3, Math.floor(input.depth)));
  const maxNodes = Math.max(1, Math.min(100, Math.floor(input.maxNodes)));

  const entityMap = new Map<string, RawEntityRecord>();
  for (const row of entities) {
    if (!input.includeDeleted && row.deleted_at !== null) continue;
    entityMap.set(row.id, row);
  }

  const root = entityMap.get(input.id);
  if (!root) return null;

  const visited = new Map<string, LinksGraphNode>();
  visited.set(root.id, {
    id: root.id,
    type: root.type,
    depth: 0,
    deleted: root.deleted_at !== null,
  });

  let frontier: string[] = [root.id];
  let truncated = false;

  for (let currentDepth = 1; currentDepth <= depthLimit; currentDepth += 1) {
    if (frontier.length === 0) break;
    const frontierSet = new Set(frontier);
    const candidateIds = new Set<string>();

    for (const edge of links) {
      if (frontierSet.has(edge.source_id) && !visited.has(edge.target_id)) {
        if (entityMap.has(edge.target_id)) candidateIds.add(edge.target_id);
      }
      if (frontierSet.has(edge.target_id) && !visited.has(edge.source_id)) {
        if (entityMap.has(edge.source_id)) candidateIds.add(edge.source_id);
      }
    }

    const sortedCandidates = [...candidateIds].sort((a, b) => a.localeCompare(b));
    const nextFrontier: string[] = [];

    for (const candidateId of sortedCandidates) {
      if (visited.size >= maxNodes) {
        truncated = true;
        break;
      }
      const entity = entityMap.get(candidateId);
      if (!entity) continue;
      visited.set(entity.id, {
        id: entity.id,
        type: entity.type,
        depth: currentDepth,
        deleted: entity.deleted_at !== null,
      });
      nextFrontier.push(entity.id);
    }

    if (truncated) break;
    frontier = nextFrontier;
  }

  const nodes = [...visited.values()].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));

  const edgeDedup = new Map<string, LinksGraphEdge>();
  for (const edge of links) {
    if (!visited.has(edge.source_id) || !visited.has(edge.target_id)) continue;
    const key = `${edge.source_id}|${edge.target_id}|${edge.relation}`;
    if (!edgeDedup.has(key)) {
      edgeDedup.set(key, {
        sourceId: edge.source_id,
        targetId: edge.target_id,
        relation: edge.relation,
      });
    }
  }

  const edges = [...edgeDedup.values()].sort(
    (a, b) =>
      a.sourceId.localeCompare(b.sourceId) ||
      a.targetId.localeCompare(b.targetId) ||
      a.relation.localeCompare(b.relation),
  );

  return {
    rootId: input.id,
    depth: depthLimit,
    truncated,
    nodes,
    edges,
  };
}

export async function linksGraph(c: PoolClient, input: LinksGraphInput): Promise<LinksGraphResult> {
  const depthLimit = Math.max(1, Math.min(3, Math.floor(input.depth)));
  const maxNodes = Math.max(1, Math.min(100, Math.floor(input.maxNodes)));

  const rootResult = await c.query<RawEntityRecord>(
    `SELECT id, type, deleted_at
     FROM foundation.entities
     WHERE id = $1
       AND foundation.visible(owner_id, scope_id)
       AND ($2::boolean OR deleted_at IS NULL)`,
    [input.id, input.includeDeleted],
  );
  const root = first(rootResult.rows);

  const visited = new Map<string, LinksGraphNode>();
  visited.set(root.id, {
    id: root.id,
    type: root.type,
    depth: 0,
    deleted: root.deleted_at !== null,
  });

  let frontier: string[] = [root.id];
  let truncated = false;

  for (let currentDepth = 1; currentDepth <= depthLimit; currentDepth += 1) {
    if (frontier.length === 0) break;

    const adjacentLinks = (
      await c.query<RawLinkRecord>(
        `SELECT source_id, target_id, relation
         FROM foundation.links
         WHERE foundation.visible(owner_id, scope_id)
           AND (source_id = ANY($1::uuid[]) OR target_id = ANY($1::uuid[]))
         ORDER BY source_id, target_id, relation`,
        [frontier],
      )
    ).rows;

    const frontierSet = new Set(frontier);
    const candidateIds = new Set<string>();
    for (const edge of adjacentLinks) {
      if (frontierSet.has(edge.source_id) && !visited.has(edge.target_id)) {
        candidateIds.add(edge.target_id);
      }
      if (frontierSet.has(edge.target_id) && !visited.has(edge.source_id)) {
        candidateIds.add(edge.source_id);
      }
    }

    if (candidateIds.size === 0) break;

    const sortedCandidateIds = [...candidateIds].sort((a, b) => a.localeCompare(b));
    const neighborRows = (
      await c.query<RawEntityRecord>(
        `SELECT id, type, deleted_at
         FROM foundation.entities
         WHERE id = ANY($1::uuid[])
           AND foundation.visible(owner_id, scope_id)
           AND ($2::boolean OR deleted_at IS NULL)
         ORDER BY id`,
        [sortedCandidateIds, input.includeDeleted],
      )
    ).rows;

    const nextFrontier: string[] = [];
    for (const entity of neighborRows) {
      if (visited.size >= maxNodes) {
        truncated = true;
        break;
      }
      visited.set(entity.id, {
        id: entity.id,
        type: entity.type,
        depth: currentDepth,
        deleted: entity.deleted_at !== null,
      });
      nextFrontier.push(entity.id);
    }

    if (truncated) break;
    frontier = nextFrontier;
  }

  const visitedIds = [...visited.keys()];
  const edgeRows = (
    await c.query<RawLinkRecord>(
      `SELECT source_id, target_id, relation
       FROM foundation.links
       WHERE foundation.visible(owner_id, scope_id)
         AND source_id = ANY($1::uuid[])
         AND target_id = ANY($1::uuid[])
       ORDER BY source_id, target_id, relation`,
      [visitedIds],
    )
  ).rows;

  const nodes = [...visited.values()].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  const edges: LinksGraphEdge[] = edgeRows.map((row) => ({
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation,
  }));

  return {
    rootId: input.id,
    depth: depthLimit,
    truncated,
    nodes,
    edges,
  };
}
