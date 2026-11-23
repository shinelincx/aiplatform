import type { ExecutionQa, ExecutionReview, IndependentCheck, IndependentCheckResult, VerificationCheck, VerificationReport } from './verification';
import type { ExecutionDelivery, PatchArtifact } from './delivery';
import type { AgentAssignment, ArchitecturePlan } from './agents';
import type { RequirementContent } from './projects';
import type { KnowledgeSnapshot } from './knowledge';
import type { DecisionQuestion } from './decisions';

export interface ExecutionRevision {
  runId: string;
  patchHash: string;
  reason: string;
}

export interface ReviewEvidence {
  patchHash: string;
  summary: string;
  url?: string;
  author: string;
  recordedAt: string;
  check?: IndependentCheckResult;
}

export interface DevelopmentHandoff {
  agent: AgentAssignment;
  plan?: ArchitecturePlan;
  requirement?: RequirementContent;
  knowledge?: KnowledgeSnapshot[];
  revision?: ExecutionRevision;
  decisions?: { question: string; answer: string }[];
}

export interface ExecutionFailure {
  runId: string;
  code: string;
  decisions?: DecisionQuestion[];
}

export interface ExecutionOffer {
  id: string;
  taskId: string;
  projectId: string;
  repository: string;
  defaultBranch: string;
  repositoryToken?: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  checks?: VerificationCheck[];
  archivePatch?: boolean;
  detailedEvents?: true;
  turnUsage?: true;
  decisionReporting?: true;
  development?: DevelopmentHandoff | null;
}

export type ExecutionState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export interface ExecutionRun {
  id: string;
  status: ExecutionState;
  workerId: string | null;
  requestedWorkerId?: string | null;
  threadId: string | null;
  lastSequence: number;
  cancelRequested: boolean;
  createdAt: string;
  finishedAt: string | null;
  report: VerificationReport | null;
  checkPlan?: VerificationCheck[];
  independentChecks?: IndependentCheck[];
  review: ExecutionReview | null;
  artifact: PatchArtifact | null;
  delivery: ExecutionDelivery | null;
  qa?: ExecutionQa | null;
  revision?: ExecutionRevision | null;
  evidence?: ReviewEvidence[];
  failure?: ExecutionFailure | null;
}

export function executionQualityGate(
  run: Pick<ExecutionRun, 'independentChecks' | 'checkPlan' | 'report' | 'evidence'>,
  archiveHash?: string | null,
) {
  const required = run.independentChecks ?? [];
  if (!required.length) return null;
  const checkPlan = run.checkPlan ?? [];
  const report = run.report;
  const workerReady = Boolean(archiveHash && report?.patchHash === archiveHash && report.passed
    && checkPlan.length > 0 && report.checks.length === checkPlan.length
    && checkPlan.every(({ name }) => report.checks.some(result => result.name === name && result.status === 'passed' && result.exitCode === 0)));
  const latest = new Map<string, IndependentCheckResult['status']>();
  if (archiveHash) {
    for (const entry of run.evidence ?? []) {
      if (entry.patchHash === archiveHash && entry.check?.source === 'archive') latest.set(entry.check.name, entry.check.status);
    }
  }
  const checks = required.map(item => ({ ...item, status: latest.get(item.name) ?? ('missing' as const) }));
  return { workerReady, checks, ready: workerReady && checks.every(item => item.status === 'passed') };
}

export interface ExecutionEvent {
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
