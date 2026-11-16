import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveVerificationCoverage } from '../packages/core/dist/index.js';
import { findInlineAgentWorkSecret } from '../packages/core/dist/secretPolicy.js';
test('extracted verification oracle keeps absent/failed evidence distinct from passed', () => {
  const steps = [{ id: 'one', key: 'one', title: 'Check actual effect', required: true }];
  assert.equal(deriveVerificationCoverage([], []).state, 'unverified');
  assert.equal(deriveVerificationCoverage(steps, []).state, 'unverified');
  const attempt = (outcome, second) => ({
    stepId: 'one',
    outcome,
    ranAt: `2026-01-01T00:00:0${second}Z`,
    createdAt: `2026-01-01T00:00:0${second}Z`,
  });
  assert.equal(deriveVerificationCoverage(steps, [attempt('passed', 1)]).state, 'commands_passed');
  assert.equal(
    deriveVerificationCoverage(steps, [attempt('passed', 1), attempt('failed', 2)]).state,
    'failed',
  );
  assert.equal(deriveVerificationCoverage(steps, [attempt('error', 1)]).state, 'failed');
});
test('extracted secret detector returns metadata without detected contents', () => {
  assert.equal(findInlineAgentWorkSecret({ output: 'ordinary evidence' }), null);
  assert.deepEqual(findInlineAgentWorkSecret({ password: 'synthetic-placeholder' }), {
    kind: 'key',
    path: 'workItem.password',
  });
});
test('evidence with identical millisecond timestamps uses server sequence order', () => {
  const steps = [{ id: 'one', key: 'one', title: 'Boundary', required: true }];
  const timestamp = '2026-01-01T00:00:00.001Z';
  const base = { stepId: 'one', ranAt: timestamp, createdAt: timestamp };
  assert.equal(
    deriveVerificationCoverage(steps, [
      { ...base, outcome: 'passed', sequence: 1 },
      { ...base, outcome: 'failed', sequence: 2 },
    ]).state,
    'failed',
  );
});
