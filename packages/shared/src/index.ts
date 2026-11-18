export type { Account, GitHubInstallation, GitHubRepository, Project, ProjectMember, ProjectRole,
  RepositoryBinding, Session } from './projects';
export { canTransitionTask, taskPriorities, taskTransitions } from './tasks';
export type { Task, TaskDetail, TaskEvent, TaskPriority, TaskStatus } from './tasks';
export { agentRoleLabels, planningRoles } from './agents';
export type { AgentAssignment, AgentPlan, AgentRegistry, AgentRole, AgentVersion, ArchitecturePlan, DeveloperRole,
  DirectorPlan, PlanningOutput, PlanningRole, ProductPlan, ProjectAgent, ProjectSkill, SkillVersion } from './agents';
export { decodeWorkerMessage, isWorkerId, workerHeartbeatMs, workerOfflineMs, workerProtocolVersion } from './workers';
export type { WorkerCapabilities, WorkerCredential, WorkerEnvelope, WorkerMessageType, WorkerReport } from './workers';
export type { ExecutionEvent, ExecutionOffer, ExecutionRun, ExecutionState } from './executions';
export { maxPatchBytes } from './delivery';
export type { ExecutionDelivery, PatchArtifact } from './delivery';
export { canRepair, maxVerificationAttempts, parseCheckPlan } from './verification';
export type { CheckResult, ExecutionReview, VerificationCheck, VerificationReport } from './verification';

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
