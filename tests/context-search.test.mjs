import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  operations,
  packetOmissionTypes,
  searchDomains,
} from '../packages/contracts/dist/index.js';
import {
  RECENCY_DECAY_HALF_LIFE_DAYS,
  buildPrefixTsQuery,
  computeRecencyDecay,
  computeScopedCandidateDigest,
  makeSearchSnippet,
  permittedSearchDomains,
  sanitizeSearchTerms,
} from '../packages/core/dist/content.js';

test('sanitizeSearchTerms strips tsquery operators, deduplicates, and bounds tokens', () => {
  assert.deepEqual(sanitizeSearchTerms('  Postgres   FTS  postgres '), ['postgres', 'fts']);
  assert.deepEqual(sanitizeSearchTerms("foo:bar! & (baz|qux) 'drop--' <*> \\hello/world"), [
    'foo',
    'bar',
    'baz',
    'qux',
    'drop',
    'hello',
    'world',
  ]);
  assert.deepEqual(sanitizeSearchTerms('!!! --- ::: &&& |||'), []);
  assert.deepEqual(sanitizeSearchTerms('Café naïve 42'), ['café', 'naïve', '42']);

  const manyTokens = Array.from({ length: 40 }, (_, i) => `tok${i}`).join(' ');
  assert.equal(sanitizeSearchTerms(manyTokens).length, 24);

  const longToken = 'a'.repeat(120);
  assert.equal(sanitizeSearchTerms(longToken)[0].length, 64);
});

test('buildPrefixTsQuery constructs safe prefix tsquery strings and returns null when empty', () => {
  assert.equal(buildPrefixTsQuery('zephyrlat'), 'zephyrlat:*');
  assert.equal(buildPrefixTsQuery('coord persist'), 'coord:* & persist:*');
  assert.equal(
    buildPrefixTsQuery("alpha:* & (beta|gamma)! 'delta'"),
    'alpha:* & beta:* & gamma:* & delta:*',
  );
  assert.equal(buildPrefixTsQuery('   !!! &&& () :*   '), null);
});

test('computeRecencyDecay decreases smoothly with age and clamps invalid inputs', () => {
  assert.equal(RECENCY_DECAY_HALF_LIFE_DAYS, 30);
  assert.equal(computeRecencyDecay(0), 1);
  assert.equal(computeRecencyDecay(30), 0.5);
  assert.equal(computeRecencyDecay(90), 0.25);
  assert.ok(computeRecencyDecay(1) > computeRecencyDecay(10));
  assert.ok(computeRecencyDecay(10) > computeRecencyDecay(60));
  assert.equal(computeRecencyDecay(-5), 1);
  assert.equal(computeRecencyDecay(Number.NaN), 1);
});

test('makeSearchSnippet normalizes whitespace and truncates cleanly', () => {
  assert.equal(makeSearchSnippet('  hello\n\t  world  '), 'hello world');
  const long = 'word '.repeat(80);
  const snippet = makeSearchSnippet(long, 40);
  assert.ok(snippet.length <= 40);
  assert.ok(snippet.endsWith('...'));
});

test('permittedSearchDomains enforces owner vs agent module read permissions', () => {
  const owner = {
    id: randomUUID(),
    ownerId: randomUUID(),
    scopeId: null,
    role: 'owner',
    permissions: [],
  };
  assert.deepEqual(permittedSearchDomains(owner), [...searchDomains]);
  assert.deepEqual(permittedSearchDomains(owner, ['task', 'note']), ['note', 'task']);

  const contextOnlyAgent = {
    id: randomUUID(),
    ownerId: owner.ownerId,
    scopeId: null,
    role: 'agent',
    permissions: ['context:read'],
  };
  assert.deepEqual(permittedSearchDomains(contextOnlyAgent), ['note']);
  assert.deepEqual(permittedSearchDomains(contextOnlyAgent, ['task']), []);

  const multiAgent = {
    id: randomUUID(),
    ownerId: owner.ownerId,
    scopeId: null,
    role: 'agent',
    permissions: ['context:read', 'projects:read', 'extensions:read'],
  };
  assert.deepEqual(permittedSearchDomains(multiAgent), ['note', 'project', 'object']);
  assert.deepEqual(permittedSearchDomains(multiAgent, ['project', 'task']), ['project']);
});

test('computeScopedCandidateDigest is deterministic across ordering and sensitive to revisions', () => {
  const idA = '11111111-1111-4111-8111-111111111111';
  const idB = '22222222-2222-4222-8222-222222222222';
  const d1 = computeScopedCandidateDigest([
    { id: idA, type: 'context.note', revision: 1 },
    { id: idB, type: 'context.note', revision: 2 },
  ]);
  const d2 = computeScopedCandidateDigest([
    { id: idB, type: 'context.note', revision: 2 },
    { id: idA, type: 'context.note', revision: 1 },
  ]);
  assert.match(d1, /^[a-f0-9]{64}$/);
  assert.equal(d1, d2);

  const dRevised = computeScopedCandidateDigest([
    { id: idA, type: 'context.note', revision: 2 },
    { id: idB, type: 'context.note', revision: 2 },
  ]);
  assert.notEqual(d1, dRevised);

  const dEmpty = computeScopedCandidateDigest([]);
  assert.match(dEmpty, /^[a-f0-9]{64}$/);
  assert.notEqual(dEmpty, d1);
});

test('context.search and context.packet contracts enforce strict validation', () => {
  const searchOp = operations['context.search'];
  assert.equal(searchOp.module, 'context');
  assert.equal(searchOp.write, false);
  assert.equal(searchOp.operator, false);

  const parsedDefault = searchOp.input.parse({ query: '  local search  ' });
  assert.deepEqual(parsedDefault, {
    query: 'local search',
    limit: 20,
    includeDeleted: false,
  });

  const projectId = randomUUID();
  const parsedFull = searchOp.input.parse({
    query: 'migration',
    domains: ['note', 'project'],
    projectId,
    limit: 50,
    includeDeleted: true,
  });
  assert.deepEqual(parsedFull, {
    query: 'migration',
    domains: ['note', 'project'],
    projectId,
    limit: 50,
    includeDeleted: true,
  });

  assert.throws(() => searchOp.input.parse({ query: '   ' }));
  assert.throws(() => searchOp.input.parse({ query: 'ok', domains: [] }));
  assert.throws(() => searchOp.input.parse({ query: 'ok', domains: ['work'] }));
  assert.throws(() => searchOp.input.parse({ query: 'ok', limit: 0 }));
  assert.throws(() => searchOp.input.parse({ query: 'ok', limit: 51 }));
  assert.throws(() => searchOp.input.parse({ query: 'ok', projectId: 'not-a-uuid' }));
  assert.throws(() => searchOp.input.parse({ query: 'ok', extra: true }));

  const packetOp = operations['context.packet'];
  assert.equal(packetOp.module, 'context');
  assert.equal(packetOp.write, true);
  assert.deepEqual(packetOp.input.parse({ noteIds: [] }), {
    noteIds: [],
    maxChars: 8000,
    omitUnavailable: false,
  });
  assert.deepEqual(
    packetOp.input.parse({ noteIds: [projectId], maxChars: 100, omitUnavailable: true }),
    {
      noteIds: [projectId],
      maxChars: 100,
      omitUnavailable: true,
    },
  );
  assert.throws(() => packetOp.input.parse({ noteIds: [], extra: 1 }));

  assert.deepEqual(
    [...packetOmissionTypes],
    ['budget_exceeded', 'module_disabled', 'scope_excluded', 'not_found', 'deleted'],
  );
});
