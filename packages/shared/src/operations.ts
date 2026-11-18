import type { AgentRole } from './agents';

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ModelUsage extends TokenUsage {
  model: string;
}

export interface ModelUsageRow {
  role: AgentRole | null;
  model: string | null;
  inputTokens: string;
  cachedInputTokens: string;
  outputTokens: string;
  estimatedUsd: string | null;
}

export interface ModelRate {
  model: string;
  inputUsdPerMillion: string;
  cachedInputUsdPerMillion: string;
  outputUsdPerMillion: string;
}

export interface ProjectAuditEntry {
  id: string;
  action: string;
  actor: string;
  resourceId: string;
  createdAt: string;
}

export interface ProjectOperations {
  usage: ModelUsageRow[];
  audit: ProjectAuditEntry[] | null;
  rates: ModelRate[] | null;
}

export interface ProjectOverview {
  tasks: { open: number; completed: number; approval: number };
  agentsEnabled: number;
  workers: { online: number; total: number };
  executions: { queued: number; running: number; succeeded: number; total: number };
  alerts: { taskId: string; code: string; title: string;
    kind: 'planning' | 'worker_failed' | 'worker_timeout' | 'qa' | 'delivery' }[];
}
