import type { ExecutionQa, ExecutionReview, VerificationCheck, VerificationReport } from './verification';
import type { ExecutionDelivery, PatchArtifact } from './delivery';
import type { AgentAssignment, ArchitecturePlan } from './agents';
import type { RequirementContent } from './projects';

export interface DevelopmentHandoff {
  agent: AgentAssignment;
  plan?: ArchitecturePlan;
  requirement?: RequirementContent;
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
  review: ExecutionReview | null;
  artifact: PatchArtifact | null;
  delivery: ExecutionDelivery | null;
  qa?: ExecutionQa | null;
}

export interface ExecutionEvent {
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
