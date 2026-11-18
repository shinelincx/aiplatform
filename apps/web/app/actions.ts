'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { agentRoleLabels, isWorkerId, type AgentPlan, type Project, type Session, type WorkerCredential } from '@ado/shared';
import { api, sessionCookie } from './api-client';

async function execute(path: string, options: RequestInit, authenticated = true) {
  return api(path, options, authenticated).catch(() => null);
}

function projectPath(form: FormData) {
  const id = String(form.get('projectId') ?? '');
  if (!/^[a-f0-9-]{36}$/i.test(id)) redirect('/');
  return { query: `/?project=${id}`, endpoint: `/projects/${id}` };
}

function issue(response: Response | null, fallback: string) {
  if (!response) return 'offline';
  if (response.status === 401) return 'expired';
  if (response.status === 403) return 'forbidden';
  if (response.status === 409) return 'conflict';
  return fallback;
}

export async function login(form: FormData) {
  const response = await execute('/auth/session', {
    method: 'POST',
    body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
  }, false);
  if (!response?.ok) redirect(`/?issue=${response ? 'login' : 'offline'}`);
  const session = await response.json() as Session;
  (await cookies()).set(sessionCookie, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.ADO_SECURE_COOKIES === 'true',
    maxAge: session.expiresIn,
  });
  redirect('/');
}

export async function logout() {
  const response = await execute('/auth/session', { method: 'DELETE' });
  if (!response?.ok && response?.status !== 401) redirect('/?issue=offline');
  (await cookies()).delete(sessionCookie);
  redirect('/');
}

export async function createProject(form: FormData) {
  const response = await execute('/projects', {
    method: 'POST',
    body: JSON.stringify({
      code: form.get('code'), name: form.get('name'), description: form.get('description'),
    }),
  });
  if (!response?.ok) redirect(`/?issue=${issue(response, 'project')}`);
  const project = await response.json() as Project;
  redirect(`/?project=${project.id}`);
}

export async function updateProject(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const response = await execute(endpoint, {
    method: 'PATCH',
    body: JSON.stringify({ name: form.get('name'), description: form.get('description') }),
  });
  if (!response?.ok) redirect(`${query}&issue=${issue(response, 'project')}`);
  redirect(query);
}

export async function archiveProject(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const response = await execute(`${endpoint}/archive`, { method: 'POST' });
  if (!response?.ok) redirect(`${query}&issue=${issue(response, 'project')}`);
  redirect(query);
}

export async function createUser(form: FormData) {
  const response = await execute('/users', {
    method: 'POST',
    body: JSON.stringify({
      name: form.get('name'), email: form.get('email'), password: form.get('password'),
    }),
  });
  if (!response?.ok) redirect(`/?issue=${issue(response, 'user')}`);
  redirect('/?notice=user-created');
}

export async function changeMember(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const userId = encodeURIComponent(String(form.get('userId') ?? ''));
  const role = form.get('role');
  const response = await execute(`${endpoint}/members/${userId}`, role === 'remove'
    ? { method: 'DELETE' }
    : { method: 'PUT', body: JSON.stringify({ role }) });
  if (!response?.ok) redirect(`${query}&issue=${issue(response, 'member')}`);
  redirect(query);
}

export async function bindRepository(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const response = await execute(`${endpoint}/repositories`, {
    method: 'POST',
    body: JSON.stringify({
      installationId: form.get('installationId'),
      repositoryId: form.get('repositoryId'),
      defaultBranch: form.get('defaultBranch'),
    }),
  });
  if (!response?.ok) redirect(`${query}&issue=${issue(response, 'repository')}`);
  redirect(query);
}

export async function updateRepositoryChecks(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const repositoryId = form.get('repositoryId');
  if (!isWorkerId(repositoryId)) redirect(query + '&issue=verification');
  let checks: unknown;
  try {
    checks = JSON.parse(String(form.get('checks') ?? ''));
  } catch {
    redirect(query + '&issue=verification');
  }
  const response = await execute(`${endpoint}/repositories/${repositoryId}/checks`, {
    method: 'PATCH', body: JSON.stringify({ checks }),
  });
  if (!response?.ok) redirect(`${query}&issue=${issue(response, 'verification')}`);
  redirect(`${query}&notice=checks-saved`);
}

function taskPath(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const id = String(form.get('taskId') ?? '');
  if (id && !/^[a-f0-9-]{36}$/i.test(id)) redirect(query);
  return { query: id ? `${query}&task=${id}` : query, endpoint: `${endpoint}/tasks${id ? `/${id}` : ''}`, id };
}

function taskIssue(response: Response | null) {
  return response?.status === 409 ? 'task-conflict' : issue(response, 'task');
}

export async function startAgentPlan(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const response = await execute(`${endpoint}/agent-plans`, {
    method: 'POST', body: JSON.stringify({ request: form.get('request'), repositoryId: form.get('repositoryId') }),
  });
  if (!response?.ok) redirect(`${query}&issue=${response?.status === 503 ? 'agent-config' : issue(response, 'agent-plan')}`);
  const plan = await response.json() as AgentPlan;
  redirect(`${query}&task=${plan.taskId}#task-detail`);
}

export async function retryAgentPlan(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  if (!id) redirect(query);
  const response = await execute(`${endpoint}/agent-plan/retry`, { method: 'POST' });
  if (!response?.ok) redirect(`${query}&issue=${response?.status === 503 ? 'agent-config' : issue(response, 'agent-plan')}`);
  redirect(`${query}#task-detail`);
}

export async function updateAgent(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const role = String(form.get('role') ?? '');
  if (!Object.hasOwn(agentRoleLabels, role)) redirect(query);
  const operation = form.get('operation');
  const createVersion = operation === 'publish';
  const body = createVersion ? {
    model: form.get('model'), instructions: form.get('instructions'),
    skills: form.getAll('skills').filter(Boolean).map((entry) => {
      const [id, version] = String(entry).split(':');
      return { id, version: Number(version) };
    }),
  } : operation === 'toggle' ? { enabled: form.get('enabled') === 'true' }
    : { activeVersion: Number(form.get('version')) };
  const response = await execute(`${endpoint}/agent-registry/agents/${role}${createVersion ? '/versions' : ''}`, {
    method: createVersion ? 'POST' : 'PUT', body: JSON.stringify(body),
  });
  if (!response?.ok) redirect(`${query}&issue=${issue(response, 'agent-settings')}`);
  redirect(`${query}#agent-registry`);
}

export async function updateSkill(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const id = form.get('skillId');
  if (id && !isWorkerId(id)) redirect(query);
  const toggle = id && form.get('operation') === 'toggle';
  const path = id ? `/${id}${toggle ? '' : '/versions'}` : '';
  const body = toggle ? { enabled: form.get('enabled') === 'true' }
    : { name: form.get('name'), instructions: form.get('instructions') };
  const response = await execute(`${endpoint}/agent-registry/skills${path}`, {
    method: toggle ? 'PUT' : 'POST', body: JSON.stringify(body),
  });
  if (!response?.ok) redirect(`${query}&issue=${issue(response, 'agent-settings')}`);
  redirect(`${query}#agent-registry`);
}

export async function saveTask(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  const response = await execute(endpoint, {
    method: id ? 'PATCH' : 'POST',
    body: JSON.stringify({
      code: form.get('code'), title: form.get('title'), description: form.get('description'),
      priority: form.get('priority'), repositoryId: form.get('repositoryId'), parentTaskId: form.get('parentTaskId'),
      dependencies: form.getAll('dependencies'),
      acceptanceCriteria: String(form.get('acceptanceCriteria') ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    }),
  });
  if (!response?.ok) redirect(`${query}&issue=${taskIssue(response)}`);
  const task = await response.json() as { id: string };
  redirect(`${id ? query : `${query}&task=${task.id}`}#task-detail`);
}

export async function transitionTask(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  if (!id) redirect(query);
  const response = await execute(`${endpoint}/transition`, {
    method: 'POST', body: JSON.stringify({ status: form.get('status') }),
  });
  if (!response?.ok) redirect(`${query}&issue=${taskIssue(response)}`);
  redirect(`${query}#task-detail`);
}

export async function archiveTask(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  if (!id) redirect(query);
  const response = await execute(`${endpoint}/archive`, { method: 'POST' });
  if (!response?.ok) redirect(`${query}&issue=${taskIssue(response)}`);
  redirect(`${query}#task-detail`);
}

export async function startExecution(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  if (!id) redirect(query);
  const response = await execute(`${endpoint}/executions`, { method: 'POST' });
  if (!response?.ok) redirect(`${query}&issue=${taskIssue(response)}`);
  redirect(`${query}#task-detail`);
}

export async function stopExecution(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  const runId = form.get('runId');
  if (!id || !isWorkerId(runId)) redirect(query);
  const response = await execute(`${endpoint}/executions/${runId}/cancel`, { method: 'POST' });
  if (!response?.ok) redirect(`${query}&issue=${taskIssue(response)}`);
  redirect(`${query}#task-detail`);
}

export async function reviewExecution(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  const runId = form.get('runId');
  if (!id || !isWorkerId(runId)) redirect(query);
  const response = await execute(`${endpoint}/executions/${runId}/review`, {
    method: 'POST', body: JSON.stringify({ decision: form.get('decision'), comment: form.get('comment') }),
  });
  if (!response?.ok) redirect(`${query}&issue=${issue(response, 'review')}#task-detail`);
  redirect(`${query}#task-detail`);
}

export async function publishExecution(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  const runId = form.get('runId');
  if (!id || !isWorkerId(runId)) redirect(query);
  const response = await execute(`${endpoint}/executions/${runId}/delivery`, { method: 'POST' });
  if (!response?.ok) redirect(`${query}&issue=${response?.status === 503 ? 'github-delivery-config' : issue(response, 'delivery')}#task-detail`);
  redirect(`${query}#task-detail`);
}

export interface WorkerAccessState {
  error?: string;
  notice?: string;
  credential?: WorkerCredential;
}

export async function changeWorkerAccess(_: WorkerAccessState, form: FormData): Promise<WorkerAccessState> {
  const { endpoint } = projectPath(form);
  const collection = `${endpoint}/workers`;
  const operation = form.get('operation');
  const workerId = form.get('workerId');
  let response: Response | null;
  if (operation === 'create') {
    response = await execute(collection, { method: 'POST', body: JSON.stringify({ name: form.get('name') }) });
  } else if (isWorkerId(workerId) && operation === 'rotate') {
    response = await execute(`${collection}/${workerId}/credential`, { method: 'POST' });
  } else if (isWorkerId(workerId) && (operation === 'grant' || operation === 'revoke')) {
    response = await execute(`${collection}/${workerId}`, { method: operation === 'grant' ? 'PUT' : 'DELETE' });
  } else {
    return { error: '请输入有效的 Worker ID。' };
  }
  if (!response?.ok) return { error: '操作失败，请检查项目权限和 Worker 状态。' };
  revalidatePath('/');
  if (operation === 'create' || operation === 'rotate') {
    return { credential: await response.json() as WorkerCredential };
  }
  return { notice: operation === 'grant' ? 'Worker 已获项目授权。' : 'Worker 的项目权限已撤回。' };
}
