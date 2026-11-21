import type { ProjectRequirement } from './projects';
import type { KnowledgeSnapshot } from './knowledge';

export const agentRoleLabels = {
  PROJECT_DIRECTOR: '项目总监',
  PRODUCT_MANAGER: '产品经理',
  ARCHITECT: '架构师',
  UI_UX_DESIGNER: 'UI/UX 设计师',
  FRONTEND_DEVELOPER: '前端工程师',
  BACKEND_DEVELOPER: '后端工程师',
  QA_ENGINEER: 'QA 工程师',
  RELEASE_ENGINEER: '发布工程师',
} as const;

export type AgentRole = keyof typeof agentRoleLabels;
export const developerRoles = ['FRONTEND_DEVELOPER', 'BACKEND_DEVELOPER'] as const;
export type DeveloperRole = (typeof developerRoles)[number];
export const planningRoles = ['PROJECT_DIRECTOR', 'PRODUCT_MANAGER', 'ARCHITECT'] as const;
export type PlanningRole = (typeof planningRoles)[number];

export interface SkillEvaluation {
  result: 'passed' | 'failed';
  evidence: string;
  recordedBy: string;
  recordedAt: string;
}

export interface SkillDecision {
  decision: 'approved' | 'rejected';
  decidedBy: string;
  decidedAt: string;
}

export type SkillVersionStatus = 'pending_evaluation' | 'evaluation_failed' | 'awaiting_approval' | 'approved' | 'rejected' | 'legacy';

export interface SkillVersion {
  version: number;
  instructions: string;
  status: SkillVersionStatus;
  evaluation: SkillEvaluation | null;
  decision: SkillDecision | null;
}

export function isUsableSkillVersion(version: SkillVersion) {
  return version.status === 'approved' || version.status === 'legacy';
}

export interface ProjectSkill {
  id: string;
  name: string;
  enabled: boolean;
  versions: SkillVersion[];
}

export interface AgentVersion {
  version: number;
  model: string;
  instructions: string;
  skills: { id: string; version: number }[];
}

export interface ProjectAgent {
  role: AgentRole;
  enabled: boolean;
  activeVersion: number;
  template: string;
  versions: AgentVersion[];
}

export interface AgentRegistry {
  agents: ProjectAgent[];
  skills: ProjectSkill[];
  modelConfigured: boolean;
}

export interface AgentAssignment {
  role: AgentRole;
  version: number;
  model: string;
  instructions: string;
  skills: { name: string; version: number; instructions: string }[];
}

export interface DirectorPlan {
  objective: string;
  constraints: string[];
}
export interface ProductPlan {
  title: string;
  userStory: string;
  requirements: string[];
  acceptanceCriteria: string[];
}
export interface ArchitecturePlan {
  developer: DeveloperRole;
  steps: string[];
  risks: string[];
  testApproach: string[];
}
export type PlanningOutput = DirectorPlan | ProductPlan | ArchitecturePlan;

export const planningFailureMessages = {
  network: { label: '网络连接失败或超时', hint: '检查 API 容器的出站连接、DNS 和代理路径，确认可连接模型服务后重试。' },
  credentials_or_permissions: { label: '凭证或权限问题', hint: '请管理员检查模型服务凭证及项目权限，确认该凭证有权使用所选模型后重试。' },
  model_unavailable: { label: '模型不可用', hint: '请管理员确认所选模型仍可用并核对规划模型配置。' },
  rate_limited: { label: '模型服务限流', hint: '等待限流窗口结束后重试，或请管理员检查服务配额。' },
  server_error: { label: '模型服务异常', hint: '检查模型服务运行状态，待服务恢复后重试。' },
  invalid_structured_output: { label: '结构化输出无效', hint: '重试当前阶段。如果问题持续，请管理员检查规划模型是否支持所需的结构化输出。' },
  unknown: { label: '原因未知', hint: '重试当前阶段。如果问题持续，请联系项目管理员并提供任务编号。' },
} as const;

export type PlanningFailureCategory = keyof typeof planningFailureMessages;

export function isPlanningFailureCategory(value: unknown): value is PlanningFailureCategory {
  return typeof value === 'string' && Object.hasOwn(planningFailureMessages, value);
}

export interface AgentPlan {
  taskId: string;
  state: 'queued' | 'running' | 'failed' | 'completed' | 'cancelled';
  stage: PlanningRole | null;
  steps: { role: PlanningRole; version: number; model: string; output: PlanningOutput }[];
  error: string | null;
  failureCategory?: PlanningFailureCategory;
  requirement?: ProjectRequirement;
  knowledge?: KnowledgeSnapshot[];
}
