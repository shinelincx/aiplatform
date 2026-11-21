import { ConflictException } from '@nestjs/common';
import { executionQualityGate, type ExecutionRun } from '@ado/shared';

export type QualityGateRun = Pick<ExecutionRun, 'independentChecks' | 'checkPlan' | 'report' | 'evidence'>;

export const qualityGateColumns = `r.independent_checks AS "independentChecks", r.check_plan AS "checkPlan",
  r.verification_report AS report, r.review_evidence AS evidence`;

export function requireQualityGate(run: QualityGateRun, archiveHash?: string) {
  const gate = executionQualityGate(run, archiveHash);
  if (gate && !gate.ready) {
    throw new ConflictException({
      code: 'quality_gate', message: 'Required verification is incomplete for this archive', ...gate,
    });
  }
}
