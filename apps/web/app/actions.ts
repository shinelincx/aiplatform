'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isWorkerId, type Project, type Session, type WorkerCredential } from '@ado/shared';
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

function taskPath(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const id = String(form.get('taskId') ?? '');
  if (id && !/^[a-f0-9-]{36}$/i.test(id)) redirect(query);
  return { query: id ? `${query}&task=${id}` : query, endpoint: `${endpoint}/tasks${id ? `/${id}` : ''}`, id };
}

function taskIssue(response: Response | null) {
  return response?.status === 409 ? 'task-conflict' : issue(response, 'task');
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
