import test from 'node:test';
import assert from 'node:assert/strict';
import { operations } from '../packages/contracts/dist/index.js';
import {
  buildWorkGraph,
  computeWorkUpdateDiff,
  sanitizeReadPayload,
  sanitizeReadText,
} from '../packages/core/dist/index.js';

const SAMPLE_ID = 'ed423c54-be0f-49a8-908a-d7d1061634c0';
const SAMPLE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('work.create and work.update contracts validate rank, priority, and deduplicated labels', () => {
  const createdDefault = operations['work.create'].input.parse({
    title: 'Default metadata item',
    steps: [{ key: 'verify', title: 'Run tests', required: true }],
  });
  assert.equal(createdDefault.rank, 0);
  assert.equal(createdDefault.priority, 'normal');
  assert.deepEqual(createdDefault.labels, []);

  const createdCustom = operations['work.create'].input.parse({
    title: 'Ranked urgent item',
    rank: -25,
    priority: 'urgent',
    labels: ['  p0 ', 'backend', 'p0', '  security  '],
    steps: [{ key: 'verify', title: 'Run tests', required: true }],
  });
  assert.equal(createdCustom.rank, -25);
  assert.equal(createdCustom.priority, 'urgent');
  assert.deepEqual(createdCustom.labels, ['p0', 'backend', 'security']);

  assert.throws(() =>
    operations['work.create'].input.parse({
      title: 'Out of range rank',
      rank: 1_000_001,
      steps: [{ key: 'verify', title: 'Run tests', required: true }],
    }),
  );
  assert.throws(() =>
    operations['work.create'].input.parse({
      title: 'Invalid priority',
      priority: 'critical',
      steps: [{ key: 'verify', title: 'Run tests', required: true }],
    }),
  );
  assert.throws(() =>
    operations['work.create'].input.parse({
      title: 'Empty label',
      labels: ['   '],
      steps: [{ key: 'verify', title: 'Run tests', required: true }],
    }),
  );
  assert.throws(() =>
    operations['work.create'].input.parse({
      title: 'Too many labels',
      labels: Array.from({ length: 31 }, (_, i) => `label-${i}`),
      steps: [{ key: 'verify', title: 'Run tests', required: true }],
    }),
  );
  assert.throws(() =>
    operations['work.create'].input.parse({
      title: 'Overlong label',
      labels: ['a'.repeat(65)],
      steps: [{ key: 'verify', title: 'Run tests', required: true }],
    }),
  );

  // Metadata-only work.update is valid without title/description/steps.
  const metaUpdate = operations['work.update'].input.parse({
    id: SAMPLE_ID,
    revision: 2,
    rank: -10,
    priority: 'high',
    labels: [' triage ', 'triage', 'wave-4'],
    reason: 'Reprioritize queue',
  });
  assert.equal(metaUpdate.rank, -10);
  assert.equal(metaUpdate.priority, 'high');
  assert.deepEqual(metaUpdate.labels, ['triage', 'wave-4']);
  assert.equal(metaUpdate.title, undefined);

  // Rejects update with no mutable fields at all.
  assert.throws(() =>
    operations['work.update'].input.parse({
      id: SAMPLE_ID,
      revision: 2,
      reason: 'Missing mutable fields',
    }),
  );
});

test('computeWorkUpdateDiff separates non-invalidating metadata edits from intent edits', () => {
  const base = {
    title: 'Implement read sanitizer',
    description: 'Strip invisible characters and redact leaked secrets.',
    steps: [{ key: 'unit', title: 'Run unit suite', required: true }],
    rank: 0,
    priority: 'normal',
    labels: ['security'],
  };

  // Pure metadata change does NOT invalidate evidence.
  const metaOnly = computeWorkUpdateDiff(base, {
    rank: -5,
    priority: 'high',
    labels: ['security', 'wave-4'],
  });
  assert.equal(metaOnly.invalidatedEvidence, false);
  assert.deepEqual(metaOnly.changedFields, ['rank', 'priority', 'labels']);
  assert.deepEqual(metaOnly.before, {
    rank: 0,
    priority: 'normal',
    labels: ['security'],
  });
  assert.deepEqual(metaOnly.after, {
    rank: -5,
    priority: 'high',
    labels: ['security', 'wave-4'],
  });

  // Re-sending identical title/description/steps alongside a rank tweak still does NOT invalidate evidence.
  const unchangedIntentWithRank = computeWorkUpdateDiff(base, {
    title: base.title,
    description: base.description,
    steps: [{ key: 'unit', title: 'Run unit suite', required: true }],
    rank: 10,
  });
  assert.equal(unchangedIntentWithRank.invalidatedEvidence, false);
  assert.deepEqual(unchangedIntentWithRank.changedFields, ['rank']);
  assert.deepEqual(unchangedIntentWithRank.before, { rank: 0 });
  assert.deepEqual(unchangedIntentWithRank.after, { rank: 10 });

  // Changing title invalidates evidence.
  const titleEdit = computeWorkUpdateDiff(base, {
    title: 'Implement read sanitizer v2',
    rank: -1,
  });
  assert.equal(titleEdit.invalidatedEvidence, true);
  assert.deepEqual(titleEdit.changedFields, ['title', 'rank']);
  assert.deepEqual(titleEdit.before, { title: base.title, rank: 0 });
  assert.deepEqual(titleEdit.after, { title: 'Implement read sanitizer v2', rank: -1 });

  // Changing verification steps invalidates evidence.
  const stepsEdit = computeWorkUpdateDiff(base, {
    steps: [
      { key: 'unit', title: 'Run unit suite', required: true },
      { key: 'pg17', title: 'Run PG17 acceptance', required: true },
    ],
  });
  assert.equal(stepsEdit.invalidatedEvidence, true);
  assert.deepEqual(stepsEdit.changedFields, ['steps']);
  assert.equal(stepsEdit.before.steps.length, 1);
  assert.equal(stepsEdit.after.steps.length, 2);

  // Defense-in-depth: pre-existing secrets in old field values are redacted out of event diffs.
  const leakedBefore = computeWorkUpdateDiff(
    { ...base, description: 'Legacy leak sk-proj-abcdefghijklmnop123456' },
    { description: 'Cleaned description' },
  );
  assert.equal(leakedBefore.invalidatedEvidence, true);
  assert.equal(leakedBefore.before.description, 'Legacy leak [REDACTED]');
  assert.equal(leakedBefore.after.description, 'Cleaned description');
});

test('buildWorkGraph projects rank, priority, labels and breaks next-queue ties by rank', () => {
  const unverified = {
    state: 'unverified',
    required: 1,
    covered: 0,
    passed: 0,
    missingStepIds: ['s1'],
    failedStepIds: [],
    steps: [],
  };
  const graph = buildWorkGraph(
    [
      {
        id: 'later-higher-rank',
        revision: 1,
        title: 'Higher priority leaf',
        description: '',
        rank: -10,
        priority: 'urgent',
        labels: ['p0', 'wave-4'],
        status: 'queued',
        plan_version: 1,
        summary: null,
        claimable: true,
        deleted_at: null,
        created_at: '2026-11-19T12:05:00.000Z',
        coverage: unverified,
        links: [],
      },
      {
        id: 'earlier-default-rank',
        revision: 1,
        title: 'Default rank leaf',
        description: '',
        status: 'queued',
        plan_version: 1,
        summary: null,
        claimable: true,
        deleted_at: null,
        created_at: '2026-11-19T12:00:00.000Z',
        coverage: unverified,
        links: [],
      },
    ],
    [],
  );

  const urgentNode = graph.nodes.find((n) => n.id === 'later-higher-rank');
  const defaultNode = graph.nodes.find((n) => n.id === 'earlier-default-rank');
  assert.equal(urgentNode.rank, -10);
  assert.equal(urgentNode.priority, 'urgent');
  assert.deepEqual(urgentNode.labels, ['p0', 'wave-4']);
  assert.equal(defaultNode.rank, 0);
  assert.equal(defaultNode.priority, 'normal');
  assert.deepEqual(defaultNode.labels, []);
  assert.deepEqual(graph.next, ['later-higher-rank', 'earlier-default-rank']);
});

test('sanitizeReadText strips invisible/bidi/null chars and preserves normal whitespace and Unicode', () => {
  const input =
    '\uFEFFHello\u200B \u202Eworld\u202C\u0000!\n\tIndented café 日本語 → ✓\r\n\u2066isolated\u2069\u200F';
  const result = sanitizeReadText(input);
  assert.equal(result.text, 'Hello world!\n\tIndented café 日本語 → ✓\r\nisolated');
  assert.equal(result.strippedInvisibleCount, 8);
  assert.equal(result.redactedSecretCount, 0);

  // Idempotent on clean text.
  const second = sanitizeReadText(result.text);
  assert.equal(second.text, result.text);
  assert.equal(second.strippedInvisibleCount, 0);
  assert.equal(second.redactedSecretCount, 0);
});

test('sanitizeReadText redacts recognizable secrets including obfuscated tokens', () => {
  const samples = [
    'OpenAI sk-proj-1234567890abcdef123456',
    'Anthropic sk-ant-api03-1234567890abcdef',
    'GitHub ghp_1234567890abcdefghij123456',
    'AWS AKIAIOSFODNN7EXAMPLE',
    'Header Authorization: Bearer super_secret_token_999',
    'Key -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----',
    'Truncated -----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXk=',
    'Assign token=abc123def456xyz and password="hunter2-secret" and secret=my_super_secret',
    'URI postgres://admin:s3cr3tPass@localhost:5432/siftable',
    'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'Obfuscated ghp_\u200B1234567890abcdefghij123456',
  ];

  for (const sample of samples) {
    const first = sanitizeReadText(sample);
    assert.ok(first.redactedSecretCount >= 1, `Expected redaction for: ${sample}`);
    assert.ok(first.text.includes('[REDACTED]'), `Expected [REDACTED] in: ${first.text}`);

    // Second pass must be idempotent with zero additional redactions.
    const second = sanitizeReadText(first.text);
    assert.equal(second.text, first.text);
    assert.equal(second.strippedInvisibleCount, 0);
    assert.equal(second.redactedSecretCount, 0);
  }

  assert.equal(
    sanitizeReadText('URI postgres://admin:s3cr3tPass@localhost:5432/siftable').text,
    'URI postgres://[REDACTED]@localhost:5432/siftable',
  );
  assert.equal(
    sanitizeReadText('Obfuscated ghp_\u200B1234567890abcdefghij123456').text,
    'Obfuscated [REDACTED]',
  );
});

test('sanitizeReadText negative tests preserve benign prose, env references, and structured scalars', () => {
  const benign = [
    'Rotate your token before expiry and never commit a password or secret.',
    'Use Authorization: Bearer $SIFT_TOKEN or Bearer ${API_TOKEN} or Bearer %TOKEN%.',
    'Config template: token=$SIFT_TOKEN password=${DB_PASS} secret=%APP_SECRET%',
    'Database URL template: postgres://app:${DB_PASS}@localhost:5432/siftable',
    'Boolean flags: password=false token=null secret=none',
    'Regular markdown `npm run test:isolated` and path /Users/dev/project/file.ts',
    SAMPLE_ID,
    '2026-11-19T22:52:11.123Z',
    SAMPLE_SHA256,
  ];

  for (const text of benign) {
    const res = sanitizeReadText(text);
    assert.equal(res.text, text, `Unexpected mutation of benign text: ${text}`);
    assert.equal(res.strippedInvisibleCount, 0);
    assert.equal(res.redactedSecretCount, 0);
  }
});

test('sanitizeReadPayload recursively sanitizes nested read payloads while preserving UUIDs, Dates, and digests', () => {
  const createdAt = new Date('2026-11-19T22:52:11.000Z');
  const payload = {
    id: SAMPLE_ID,
    created_at: createdAt,
    createdAtIso: '2026-11-19T22:52:11.000Z',
    digest: SAMPLE_SHA256,
    rank: -10,
    claimable: true,
    summary: null,
    title: 'Fix\u202E login\u200B',
    labels: ['p0\uFEFF', 'security'],
    nested: {
      description: 'Leaked ghp_1234567890abcdefghij123456 and token=my_secret_123',
      artifacts: [{ id: SAMPLE_ID, digest: SAMPLE_SHA256, content: 'Header Bearer topsecret999' }],
    },
  };

  const sanitized = sanitizeReadPayload(payload);
  assert.equal(sanitized.id, SAMPLE_ID);
  assert.equal(sanitized.created_at, createdAt);
  assert.equal(sanitized.createdAtIso, '2026-11-19T22:52:11.000Z');
  assert.equal(sanitized.digest, SAMPLE_SHA256);
  assert.equal(sanitized.rank, -10);
  assert.equal(sanitized.claimable, true);
  assert.equal(sanitized.summary, null);
  assert.equal(sanitized.title, 'Fix login');
  assert.deepEqual(sanitized.labels, ['p0', 'security']);
  assert.equal(sanitized.nested.description, 'Leaked [REDACTED] and [REDACTED]');
  assert.equal(sanitized.nested.artifacts[0].id, SAMPLE_ID);
  assert.equal(sanitized.nested.artifacts[0].digest, SAMPLE_SHA256);
  assert.equal(sanitized.nested.artifacts[0].content, 'Header [REDACTED]');
});
