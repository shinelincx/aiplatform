import type { AgentAssignment } from './agents';

export const taskTransitions = {
  CREATED: ['PLANNING', 'CANCELLED'],
  PLANNING: ['WAITING_APPROVAL', 'CANCELLED', 'BLOCKED'],
  WAITING_APPROVAL: ['READY', 'REJECTED', 'CANCELLED'],
  READY: ['QUEUED', 'CANCELLED', 'BLOCKED'],
  QUEUED: ['RUNNING', 'CANCELLED', 'BLOCKED'],
  RUNNING: ['TESTING', 'FAILED', 'TIMEOUT', 'CANCELLED'],
  TESTING: ['REVIEW', 'FAILED', 'TIMEOUT', 'CANCELLED', 'QUEUED'],
  REVIEW: ['MERGED', 'REJECTED', 'CANCELLED'],
  MERGED: ['COMPLETED'],
  BLOCKED: ['PLANNING', 'CANCELLED'],
  FAILED: ['RETRYING', 'CANCELLED'],
  TIMEOUT: ['RETRYING', 'CANCELLED'],
  REJECTED: ['PLANNING', 'CANCELLED'],
  RETRYING: ['QUEUED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
} as const;

export type TaskStatus = keyof typeof taskTransitions;
export const taskPriorities = ['P0', 'P1', 'P2'] as const;
export type TaskPriority = (typeof taskPriorities)[number];

export function canTransitionTask(from: TaskStatus, to: TaskStatus) {
  return (taskTransitions[from] as readonly TaskStatus[]).includes(to);
}

export interface Task {
  id: string;
  projectId: string;
  code: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  repositoryId: string | null;
  parentTaskId: string | null;
  acceptanceCriteria: string[];
  archivedAt: string | null;
  createdAt: string;
  developer?: Pick<AgentAssignment, 'role' | 'version' | 'model'> | null;
}

export interface TaskDetail extends Task {
  dependencies: string[];
}

export interface TaskEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
