import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { moduleIds, operations } from '../packages/contracts/dist/index.js';
import {
  computeFactHash,
  evaluateMemoryStaleness,
  isValidSourceCommit,
  lifecycleBoost,
  looksLikeRawCodeDump,
  normalizeMemoryPath,
  pathProximityBoost,
  planModules,
} from '../packages/core/dist/index.js';
import { inspectCodeMemoryPaths } from '../packages/client/dist/index.js';

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Siftable Test',
      GIT_AUTHOR_EMAIL: 'test@siftable.local',
      GIT_COMMITTER_NAME: 'Siftable Test',
      GIT_COMMITTER_EMAIL: 'test@siftable.local',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return stdout.trim();
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

test('looksLikeRawCodeDump accepts concise facts and rejects fenced or dense code pastes', () => {
  assert.equal(
    looksLikeRawCodeDump(
      'Siftable isolates every tenant row via foundation.visible(owner_id, scope_id) using transaction-local app.owner_id and app.scope_id GUCs.',
    ),
    false,
  );
  assert.equal(
    looksLikeRawCodeDump(
      'Key invariants:\n- Always pass Idempotency-Key on writes.\n- Never bypass RLS with a superuser serving role.\n- Keep module schemas physically independent.',
    ),
    false,
  );

  // Fenced code dump
  assert.equal(
    looksLikeRawCodeDump('Use this snippet:\n```ts\nexport function run() {\n  return 42;\n}\n```'),
    true,
  );

  // Oversized dump (> 1200 chars)
  assert.equal(looksLikeRawCodeDump('a'.repeat(1201)), true);

  // Excessive line count (>= 8 non-empty lines)
  assert.equal(
    looksLikeRawCodeDump(Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of dump`).join('\n')),
    true,
  );

  // Dense code punctuation across >= 4 lines
  assert.equal(
    looksLikeRawCodeDump(
      [
        'if (ready) { run(); }',
        'else { abort(); }',
        'while (active) { poll(); }',
        'return { ok: true };',
      ].join('\n'),
    ),
    true,
  );

  // Multi-line code statements without braces (e.g. Python/TS declarations)
  assert.equal(
    looksLikeRawCodeDump(
      [
        'import { Pool } from "pg"',
        'const pool = new Pool()',
        'export async function queryAll() {}',
      ].join('\n'),
    ),
    true,
  );
});

test('normalizeMemoryPath, isValidSourceCommit, and computeFactHash normalize deterministically', () => {
  assert.equal(
    normalizeMemoryPath('./packages/core//src/memory.ts'),
    'packages/core/src/memory.ts',
  );
  assert.equal(
    normalizeMemoryPath('packages\\core\\src\\memory.ts'),
    'packages/core/src/memory.ts',
  );
  assert.equal(normalizeMemoryPath('packages/core/'), 'packages/core');
  assert.equal(normalizeMemoryPath('/etc/passwd'), null);
  assert.equal(normalizeMemoryPath('C:\\Windows\\System32'), null);
  assert.equal(normalizeMemoryPath('../secrets.env'), null);
  assert.equal(normalizeMemoryPath('packages/../secrets.env'), null);
  assert.equal(normalizeMemoryPath('packages/core/\u0000bad'), null);
  assert.equal(normalizeMemoryPath('   '), null);

  assert.equal(isValidSourceCommit('deadbee'), true);
  assert.equal(isValidSourceCommit('0123456789abcdef0123456789abcdef01234567'), true);
  assert.equal(isValidSourceCommit('ABCDEF12'), true);
  assert.equal(isValidSourceCommit('123456'), false);
  assert.equal(isValidSourceCommit('not-a-hex-sha'), false);
  assert.equal(isValidSourceCommit('a'.repeat(41)), false);
  assert.equal(isValidSourceCommit(null), false);

  const hashA = computeFactHash({
    kind: 'invariant',
    title: '  RLS   enforced via session GUCs ',
    summary: 'Every query runs inside transaction() with app.owner_id set.',
    paths: ['./packages/core/src/database.ts', 'modules/foundation/001.sql'],
  });
  const hashB = computeFactHash({
    kind: 'INVARIANT',
    title: 'rls enforced via session gucs',
    summary: 'every query runs inside   transaction() with app.owner_id set.',
    paths: ['modules/foundation/001.sql', 'packages\\core\\src\\database.ts'],
  });
  const hashDifferentSummary = computeFactHash({
    kind: 'invariant',
    title: 'rls enforced via session gucs',
    summary: 'Different invariant text.',
    paths: ['modules/foundation/001.sql', 'packages/core/src/database.ts'],
  });

  assert.equal(hashA, hashB);
  assert.match(hashA, /^[0-9a-f]{64}$/);
  assert.notEqual(hashA, hashDifferentSummary);
});

test('pathProximityBoost and lifecycleBoost preserve strict ranking order', () => {
  const target = ['packages/core/src/memory.ts'];
  const exact = pathProximityBoost(['packages/core/src/memory.ts'], target);
  const sameDir = pathProximityBoost(['packages/core/src/content.ts'], target);
  const dirPrefix = pathProximityBoost(['packages/core/src'], target);
  const sharedParentDeep = pathProximityBoost(['packages/core/test/memory.test.ts'], target);
  const sharedParentTop = pathProximityBoost(['packages/client/src/index.ts'], target);
  const unrelated = pathProximityBoost(['apps/server/src/index.ts'], target);
  const rootFiles = pathProximityBoost(['README.md'], ['package.json']);

  assert.ok(exact > sameDir, `expected exact (${exact}) > sameDir (${sameDir})`);
  assert.equal(sameDir, dirPrefix);
  assert.ok(
    sameDir > sharedParentDeep,
    `expected sameDir (${sameDir}) > sharedParent (${sharedParentDeep})`,
  );
  assert.ok(sharedParentDeep > sharedParentTop);
  assert.ok(
    sharedParentTop > unrelated,
    `expected sharedParent (${sharedParentTop}) > unrelated (${unrelated})`,
  );
  assert.equal(unrelated, 1.0);
  assert.equal(rootFiles, 1.0);

  const confirmed = lifecycleBoost('confirmed');
  const unreviewed = lifecycleBoost('unreviewed');
  const needsReview = lifecycleBoost('needs_review');
  const rejected = lifecycleBoost('rejected');
  const superseded = lifecycleBoost('superseded');

  assert.ok(confirmed > unreviewed);
  assert.ok(unreviewed > needsReview);
  assert.ok(needsReview > rejected);
  assert.equal(rejected, superseded);
});

test('memory module contracts and dependency plan remain optional and strict', async () => {
  assert.ok(moduleIds.includes('memory'));
  const memoryPlan = await planModules(['memory']);
  assert.deepEqual(
    memoryPlan.map((m) => m.id),
    ['foundation', 'projects', 'memory'],
  );

  // Installing the original 6 modules never pulls optional memory in automatically.
  const legacyPlan = await planModules(['projects', 'context', 'work', 'planning', 'extensions']);
  assert.equal(
    legacyPlan.some((m) => m.id === 'memory'),
    false,
  );

  assert.equal(operations['memory.store'].module, 'memory');
  assert.equal(operations['memory.store'].write, true);
  assert.equal(operations['memory.store'].operator, false);
  assert.equal(operations['memory.review'].operator, true);
  assert.equal(operations['memory.search'].write, false);
  assert.equal(operations['memory.detect_stale'].write, true);

  assert.throws(() =>
    operations['memory.store'].input.parse({
      projectId: '11111111-1111-4111-8111-111111111111',
      title: 'Strict check',
      summary: 'Unknown keys must fail',
      kind: 'invariant',
      extraField: true,
    }),
  );
});

test('inspectCodeMemoryPaths and evaluateMemoryStaleness detect real git commit drift, working-tree edits, and deleted files', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'siftable-code-memory-'));
  try {
    await git(repoDir, 'init', '-b', 'main');
    await mkdir(join(repoDir, 'packages', 'core', 'src'), { recursive: true });
    await mkdir(join(repoDir, 'packages', 'client', 'src'), { recursive: true });

    const policyPath = 'packages/core/src/secretPolicy.ts';
    const memoryPath = 'packages/core/src/memory.ts';
    const clientPath = 'packages/client/src/index.ts';

    await writeFile(join(repoDir, policyPath), 'export const policyV1 = true;\n');
    await writeFile(join(repoDir, memoryPath), 'export const memoryV1 = true;\n');
    await writeFile(join(repoDir, clientPath), 'export const clientV1 = true;\n');
    await git(repoDir, 'add', '.');
    await git(repoDir, 'commit', '-m', 'initial commit');
    const commit1 = await git(repoDir, 'rev-parse', 'HEAD');

    const baseline = await inspectCodeMemoryPaths(repoDir, [
      `./${policyPath}`,
      memoryPath,
      clientPath,
    ]);
    assert.equal(baseline.headCommit, commit1);
    assert.equal(baseline.pathCommits[policyPath], commit1);
    assert.equal(baseline.pathCommits[memoryPath], commit1);
    assert.equal(baseline.fileHashes[policyPath], sha256('export const policyV1 = true;\n'));
    assert.equal(baseline.fileHashes[memoryPath], sha256('export const memoryV1 = true;\n'));

    const storedPolicy = {
      paths: [policyPath],
      sourceCommit: commit1.slice(0, 10), // abbreviated commit SHA must match full commit SHA
      fileHashes: { [policyPath]: baseline.fileHashes[policyPath] },
    };
    const storedMemory = {
      paths: [memoryPath],
      sourceCommit: commit1,
      fileHashes: { [memoryPath]: baseline.fileHashes[memoryPath] },
    };
    const storedClient = {
      paths: [clientPath],
      sourceCommit: commit1,
      fileHashes: { [clientPath]: baseline.fileHashes[clientPath] },
    };

    // Baseline matches -> zero staleness
    assert.equal(evaluateMemoryStaleness(storedPolicy, baseline).stale, false);
    assert.equal(evaluateMemoryStaleness(storedMemory, baseline).stale, false);
    assert.equal(evaluateMemoryStaleness(storedClient, baseline).stale, false);

    // Working-tree edit without commit -> file hash drift detected
    await writeFile(join(repoDir, memoryPath), 'export const memoryV2 = true;\n');
    const dirtyInspect = await inspectCodeMemoryPaths(repoDir, [policyPath, memoryPath]);
    const dirtyEval = evaluateMemoryStaleness(storedMemory, dirtyInspect);
    assert.equal(dirtyEval.stale, true);
    assert.deepEqual(dirtyEval.changedPaths, [memoryPath]);
    assert.deepEqual(dirtyEval.reasons, [`file_hash_changed:${memoryPath}`]);
    assert.equal(evaluateMemoryStaleness(storedPolicy, dirtyInspect).stale, false);

    // Commit memory.ts change & delete client/src/index.ts on disk
    await git(repoDir, 'add', memoryPath);
    await git(repoDir, 'commit', '-m', 'update memory.ts');
    const commit2 = await git(repoDir, 'rev-parse', 'HEAD');
    assert.notEqual(commit2, commit1);
    await unlink(join(repoDir, clientPath));

    const afterChanges = await inspectCodeMemoryPaths(repoDir, [
      policyPath,
      memoryPath,
      clientPath,
    ]);
    assert.equal(afterChanges.headCommit, commit2);
    assert.equal(afterChanges.pathCommits[policyPath], commit1);
    assert.equal(afterChanges.pathCommits[memoryPath], commit2);
    assert.equal(afterChanges.fileHashes[clientPath], null);

    // Unchanged file stays fresh
    assert.equal(evaluateMemoryStaleness(storedPolicy, afterChanges).stale, false);

    // Committed edit flags both commit_changed and file_hash_changed
    const memoryEval = evaluateMemoryStaleness(storedMemory, afterChanges);
    assert.equal(memoryEval.stale, true);
    assert.deepEqual(memoryEval.changedPaths, [memoryPath]);
    assert.deepEqual(memoryEval.reasons, [
      `commit_changed:${memoryPath}`,
      `file_hash_changed:${memoryPath}`,
    ]);

    // Deleted file flags file_deleted
    const clientEval = evaluateMemoryStaleness(storedClient, afterChanges);
    assert.equal(clientEval.stale, true);
    assert.deepEqual(clientEval.changedPaths, [clientPath]);
    assert.deepEqual(clientEval.reasons, [`file_deleted:${clientPath}`]);

    // Traversal and absolute paths fail closed
    await assert.rejects(() => inspectCodeMemoryPaths(repoDir, ['../escape.txt']), /traverse/);
    await assert.rejects(
      () => inspectCodeMemoryPaths(repoDir, ['/etc/hosts']),
      /repository-relative/,
    );
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});
