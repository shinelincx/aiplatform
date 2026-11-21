import { describe, expect, it } from 'vitest';
import { executionQualityGate, type ExecutionRun, type ReviewEvidence } from '../src/executions';

const archive = 'a'.repeat(64);
const unit = { name: 'unit', status: 'passed', exitCode: 0, durationMs: 25 } as const;
const run: Pick<ExecutionRun, 'independentChecks' | 'checkPlan' | 'report' | 'evidence'> = {
  independentChecks: [{ name: 'browser', kind: 'browser' }],
  checkPlan: [{ name: 'unit', kind: 'unit', argv: ['npm', 'test'], directory: '.', timeoutSeconds: 60 }],
  report: { patchHash: archive, passed: true, attempt: 1, checks: [unit] },
};

function evidence(status: 'passed' | 'failed', patchHash = archive): ReviewEvidence {
  return {
    patchHash, summary: 'Browser check', author: 'Owner', recordedAt: '2026-01-01T00:00:00Z',
    check: { name: 'browser', status, source: 'archive', environment: 'Desktop fixture' },
  };
}

describe('executionQualityGate', () => {
  it('requires results from the current archive and uses the latest recorded attempt', () => {
    const note = { patchHash: archive, summary: 'Passed', author: 'Owner', recordedAt: '2026-01-01T00:00:00Z' };
    expect(executionQualityGate({ ...run, evidence: [note, evidence('passed', 'b'.repeat(64))] }, archive)?.checks[0].status)
      .toBe('missing');
    expect(executionQualityGate({ ...run, evidence: [evidence('passed'), evidence('failed')] }, archive)?.ready).toBe(false);
    expect(executionQualityGate({ ...run, evidence: [evidence('failed'), evidence('passed')] }, archive)?.ready).toBe(true);
  });

  it('requires the full frozen Worker plan and archive even with passing independent evidence', () => {
    const test = { ...run, evidence: [evidence('passed')] };
    expect(executionQualityGate(test)?.workerReady).toBe(false);
    const partial = { ...test, checkPlan: [...(run.checkPlan ?? []), {
      name: 'integration', kind: 'api' as const, argv: ['npm', 'run', 'integration'], directory: '.', timeoutSeconds: 60,
    }] };
    expect(executionQualityGate(partial, archive)?.ready).toBe(false);
    expect(executionQualityGate({ ...test, independentChecks: [] }, archive)).toBeNull();
  });
});
