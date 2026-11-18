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
}

export type ExecutionState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export interface ExecutionRun {
  id: string;
  status: ExecutionState;
  workerId: string | null;
  threadId: string | null;
  lastSequence: number;
  cancelRequested: boolean;
  createdAt: string;
  finishedAt: string | null;
}

export interface ExecutionEvent {
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
