import type { ProjectRequirement } from './projects';

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
export type DeveloperRole = 'FRONTEND_DEVELOPER' | 'BACKEND_DEVELOPER';
export const planningRoles = ['PROJECT_DIRECTOR', 'PRODUCT_MANAGER', 'ARCHITECT'] as const;
export type PlanningRole = (typeof planningRoles)[number];

export interface SkillVersion {
  version: number;
  instructions: string;
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

export interface AgentPlan {
  taskId: string;
  state: 'queued' | 'running' | 'failed' | 'completed' | 'cancelled';
  stage: PlanningRole | null;
  steps: { role: PlanningRole; version: number; model: string; output: PlanningOutput }[];
  error: string | null;
  requirement?: ProjectRequirement;
}
