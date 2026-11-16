export interface VerificationStep {
  id: string;
  key: string;
  title: string;
  required: boolean;
}
export interface VerificationAttempt {
  stepId: string;
  outcome: 'passed' | 'failed' | 'error';
  ranAt: string;
  createdAt: string;
  sequence?: number;
}
export type VerificationState = 'unverified' | 'commands_passed' | 'failed';
export interface VerificationCoverage {
  state: VerificationState;
  required: number;
  covered: number;
  passed: number;
  missingStepIds: string[];
  failedStepIds: string[];
  steps: {
    step: VerificationStep;
    latestAttempt: VerificationAttempt | null;
    covered: boolean;
    passed: boolean;
  }[];
}
