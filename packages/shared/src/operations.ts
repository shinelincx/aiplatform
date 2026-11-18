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
}
