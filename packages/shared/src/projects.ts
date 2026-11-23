import type { IndependentCheck, VerificationCheck } from './verification';

export interface Account {
  id: string;
  email: string;
  name: string;
  systemRole: 'admin' | 'user';
  status: 'active' | 'disabled';
}

export interface Session {
  token: string;
  expiresIn: number;
}

export type ProjectRole = 'owner' | 'member' | 'viewer';

export interface AutoApprovalSettings {
  READY: boolean;
  REVIEW: boolean;
}

export interface Project {
  id: string;
  code: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  role: ProjectRole;
}

export interface ProjectMember {
  id: string;
  email: string;
  name: string;
  role: ProjectRole;
}

export interface RequirementContent {
  title: string;
  excerpt: string;
}

export interface ProjectRequirement extends RequirementContent {
  id: string;
  referenceUrl: string;
  approvedBy: string;
  approvedAt: string;
}

export interface GitHubInstallation {
  id: number;
  account: string;
  canReadContents: boolean;
  canPublish: boolean;
}

export interface GitHubRepository {
  id: number;
  fullName: string;
  url: string;
  defaultBranch: string;
}

export interface RepositoryBinding extends Omit<GitHubRepository, 'id'> {
  id: string;
  githubId: string;
  installationId: string;
  checks: VerificationCheck[];
  independentChecks?: IndependentCheck[];
  autoDraftPr: boolean;
}
