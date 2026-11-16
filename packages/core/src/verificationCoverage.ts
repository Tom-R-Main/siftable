/**
 * Coverage of a verification plan: the latest attempt per step decides whether
 * each required step is covered and passed. Pure; split from
 * agentWorkVerificationPlanService.ts, which re-exports it.
 */
import type {
  VerificationAttempt,
  VerificationCoverage,
  VerificationState,
  VerificationStep,
} from './verificationTypes.js';

function isLaterAttempt(candidate: VerificationAttempt, current: VerificationAttempt): boolean {
  const ranDifference = new Date(candidate.ranAt).getTime() - new Date(current.ranAt).getTime();
  if (ranDifference !== 0) return ranDifference > 0;
  const createdDifference =
    new Date(candidate.createdAt).getTime() - new Date(current.createdAt).getTime();
  if (createdDifference !== 0) return createdDifference > 0;
  // PostgreSQL microseconds can collapse to the same JS millisecond. Preserve
  // server insertion order when both timestamps compare equal.
  return (candidate.sequence ?? 0) > (current.sequence ?? 0);
}

export function deriveVerificationCoverage(
  steps: VerificationStep[],
  attempts: VerificationAttempt[],
): VerificationCoverage {
  const latestByStep = new Map<string, VerificationAttempt>();
  for (const attempt of attempts) {
    const existing = latestByStep.get(attempt.stepId);
    if (!existing || isLaterAttempt(attempt, existing)) latestByStep.set(attempt.stepId, attempt);
  }

  const stepCoverage = steps.map((step) => {
    const latestAttempt = latestByStep.get(step.id) ?? null;
    return {
      step,
      latestAttempt,
      covered: latestAttempt !== null,
      passed: latestAttempt?.outcome === 'passed',
    };
  });
  const requiredSteps = stepCoverage.filter((entry) => entry.step.required);
  const missingStepIds = requiredSteps
    .filter((entry) => !entry.covered)
    .map((entry) => entry.step.id);
  const failedStepIds = requiredSteps
    .filter((entry) => entry.covered && !entry.passed)
    .map((entry) => entry.step.id);
  const covered = requiredSteps.length - missingStepIds.length;
  const passed = requiredSteps.filter((entry) => entry.passed).length;

  let state: VerificationState = 'unverified';
  if (failedStepIds.length > 0) state = 'failed';
  else if (requiredSteps.length > 0 && missingStepIds.length === 0) {
    state = 'commands_passed';
  }

  return {
    state,
    required: requiredSteps.length,
    covered,
    passed,
    missingStepIds,
    failedStepIds,
    steps: stepCoverage,
  };
}
