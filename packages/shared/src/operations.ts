import type { AutoApprovalSettings } from './projects';
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
  sourceUrl?: string | null;
  effectiveAt?: string | null;
  version?: number | null;
}

export const budgetMonthPattern = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;
export const budgetAmountPattern = /^\d{1,9}(\.\d{1,2})?$/;

export interface MonthlyUsage {
  month: string;
  budgetUsd: string | null;
  estimatedUsd: string | null;
  records: number;
  matched: number;
  undated: number;
  notice: 'unset' | 'unknown' | 'below' | 'warning' | 'reached';
}

export interface ProjectAuditEntry {
  id: string;
  action: string;
  actor: string;
  resourceId: string;
  createdAt: string;
  details?: { autoApproval?: AutoApprovalSettings; previousAutoApproval?: AutoApprovalSettings; version?: number; role?: AgentRole; enabled?: boolean;
    versionId?: string | null; previousVersionId?: string | null; excerptHash?: string;
    model?: string; sourceUrl?: string | null; effectiveAt?: string | null; month?: string; budgetUsd?: string | null;
    delivery?: {
      outcome: string; runId: string; pullNumber: number; repository: string;
      originalCommitSha: string; finalCommitSha: string; reason?: string | null;
      mergeSha?: string; ciRunId?: number; ciAttempt?: number; authorization?: string;
      gateCheckId?: number; mergedBy?: string;
    };
  } | null;
}

export interface ProjectOperations {
  usage: ModelUsageRow[];
  monthly: MonthlyUsage;
  audit: ProjectAuditEntry[] | null;
  rates: ModelRate[] | null;
}

export interface ProjectOverview {
  tasks: { open: number; completed: number; approval: number };
  agentsEnabled: number;
  workers: { online: number; total: number; diskPaused: number };
  executions: { queued: number; running: number; succeeded: number; total: number };
  alerts: { taskId: string; code: string; title: string;
    kind: 'planning' | 'worker_failed' | 'worker_timeout' | 'worker_unavailable' | 'qa' | 'delivery' }[];
}
