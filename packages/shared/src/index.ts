export type { Account, GitHubInstallation, GitHubRepository, Project, ProjectMember, ProjectRole,
  ProjectRequirement, RepositoryBinding, RequirementContent, Session } from './projects';
export { canTransitionTask, taskPriorities, taskTransitions } from './tasks';
export type { Task, TaskDetail, TaskEvent, TaskPriority, TaskStatus } from './tasks';
export { agentRoleLabels, developerRoles, isPlanningFailureCategory, isUsableSkillVersion, planningFailureMessages, planningRoles } from './agents';
export type { AgentAssignment, AgentPlan, AgentRegistry, AgentRole, AgentVersion, ArchitecturePlan, DeveloperRole,
  DirectorPlan, PlanningFailureCategory, PlanningOutput, PlanningRole, ProductPlan, ProjectAgent, ProjectSkill,
  SkillDecision, SkillEvaluation, SkillVersion, SkillVersionStatus } from './agents';
export { decodeWorkerMessage, isWorkerId, workerCredentialLifetimeHours, workerDiskPressure, workerHeartbeatMs, workerMaxPayloadBytes,
  workerOfflineMs, workerProtocolVersion } from './workers';
export type { WorkerCapabilities, WorkerCredential, WorkerEnvelope, WorkerHeartbeat, WorkerMessageType,
  WorkerRecovery, WorkerReport, WorkerResources } from './workers';
export type { DevelopmentHandoff, ExecutionEvent, ExecutionOffer, ExecutionRevision, ExecutionRun, ExecutionState, ReviewEvidence } from './executions';
export { maxPatchBytes } from './delivery';
export type { ExecutionDelivery, PatchArtifact } from './delivery';
export { canRepair, checkFailureStatuses, maxVerificationAttempts, parseCheckPlan } from './verification';
export type { CheckFailureReason, CheckResult, ExecutionQa, ExecutionReview, QaAssessment, VerificationCheck, VerificationReport } from './verification';
export type { ModelRate, ModelUsage, ModelUsageRow, ProjectAuditEntry, ProjectOperations, ProjectOverview, TokenUsage } from './operations';

export interface ApiHealth {
  service: 'ado-api';
  status: 'ok';
}

export async function checkApiHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', baseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.service === 'ado-api' && health?.status === 'ok';
  } catch {
    return false;
  }
}
