export interface VerificationCheck {
  name: string;
  kind: 'unit' | 'api' | 'static';
  directory: string;
  argv: string[];
  timeoutSeconds: number;
}

export interface CheckResult {
  name: string;
  status: 'passed' | 'failed' | 'timed_out' | 'unavailable';
  durationMs: number;
  exitCode: number | null;
  reason?: CheckFailureReason;
}

export const independentCheckKinds = ['static', 'unit', 'integration', 'browser', 'security', 'dependency'] as const;
export const independentCheckStatuses = ['passed', 'failed', 'timed_out', 'unavailable'] as const;

export interface IndependentCheck {
  name: string;
  kind: typeof independentCheckKinds[number];
}

export interface IndependentCheckResult {
  name: string;
  status: typeof independentCheckStatuses[number];
  environment: string;
  source: 'archive';
}

export function parseIndependentChecks(value: unknown): IndependentCheck[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Expected at most eight independent checks');
  const checks = value.map((entry): IndependentCheck => {
    const name = entry?.name;
    const kind = independentCheckKinds.find(item => item === entry?.kind);
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(name) || !kind) {
      throw new Error('Invalid independent check name or kind');
    }
    return { name, kind };
  });
  if (new Set(checks.map(({ name }) => name)).size !== checks.length) {
    throw new Error('Independent check names must be unique');
  }
  return checks;
}

export const checkFailureStatuses = {
  directory_unavailable: 'unavailable',
  executable_unavailable: 'unavailable',
  start_failed: 'unavailable',
  process_terminated: 'unavailable',
  timeout: 'timed_out',
  nonzero_exit: 'failed',
} as const;
export type CheckFailureReason = keyof typeof checkFailureStatuses;

export interface VerificationReport {
  attempt: number;
  patchHash: string;
  checks: CheckResult[];
  passed: boolean;
}

export interface ExecutionReview {
  decision: 'approved' | 'rejected';
  comment: string;
  reviewer: string;
  reviewedAt: string;
}

export interface QaAssessment {
  recommendation: 'ready' | 'changes_requested' | 'insufficient_evidence';
  testCases: string[];
  findings: string[];
}

export interface ExecutionQa {
  state: 'queued' | 'running' | 'failed' | 'completed' | 'cancelled';
  version: number;
  model: string;
  patchHash: string;
  partialPatch: boolean;
  assessment: QaAssessment | null;
}

export const maxVerificationAttempts = 3;

export function canRepair(report: VerificationReport) {
  return !report.passed && report.attempt < maxVerificationAttempts
    && report.checks.every(({ status }) => status === 'passed' || status === 'failed');
}

export function parseCheckPlan(value: unknown): VerificationCheck[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Expected an array with at most eight checks');
  const checks = value.map((item): VerificationCheck => {
    if (!item || typeof item !== 'object') throw new Error('Expected a check object');
    const { name, kind, argv, directory = '.', timeoutSeconds = 90 } = item;
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(name)) {
      throw new Error('Invalid check name');
    }
    if (kind !== 'unit' && kind !== 'api' && kind !== 'static') throw new Error('Invalid check kind');
    if (typeof directory !== 'string' || directory.length > 160 || (directory !== '.'
      && directory.split('/').some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..'))) {
      throw new Error('Invalid repository-relative directory');
    }
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 16
      || argv.some((arg) => typeof arg !== 'string' || arg.length < 1 || arg.length > 160
        || Array.from(arg).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/.test(argv[0])) {
      throw new Error('Expected an executable and separate arguments');
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
      throw new Error('Check timeout must be between 1 and 300 seconds');
    }
    return { name, kind, directory, argv, timeoutSeconds };
  });
  if (new Set(checks.map(({ name }) => name)).size !== checks.length) throw new Error('Check names must be unique');
  return checks;
}
