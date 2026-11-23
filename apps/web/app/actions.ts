'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { agentRoleLabels, budgetAmountPattern, budgetMonthPattern, isWorkerId, type AgentPlan, type Session, type WorkerCredential } from '@ado/shared';
import { api, sessionCookie } from './api-client';
import { settingsHref, settingsPath } from './workspace';

async function execute(path: string, options: RequestInit, authenticated = true) {
  const response = await api(path, options, authenticated).catch(() => null);
  if (response?.ok && path !== '/auth/session') revalidatePath('/');
  return response;
}

function projectPath(form: FormData) {
  const id = String(form.get('projectId') ?? '');
  if (!/^[a-f0-9-]{36}$/i.test(id)) redirect('/');
  return { query: `/?project=${id}`, endpoint: `/projects/${id}` };
}

function atDialog(query: string, key: string) {
  return `${query}${query.includes('?') ? '&' : '?'}dialog=${encodeURIComponent(key)}`;
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

export async function updateProfile(form: FormData) {
  const target = atDialog(settingsPath('account'), 'profile');
  const response = await execute('/auth/profile', {
    method: 'PATCH', body: JSON.stringify({ name: form.get('name') }),
  });
  if (!response?.ok) redirect(`${target}&issue=${issue(response, 'profile')}`);
  revalidatePath(settingsHref, 'layout');
  redirect(`${target}&notice=profile-saved`);
}

export async function changePassword(form: FormData) {
  const target = atDialog(settingsPath('account'), 'password');
  const currentPassword = form.get('currentPassword');
  const newPassword = form.get('newPassword');
  if (newPassword !== form.get('confirmPassword')) redirect(`${target}&issue=password-confirm`);
  if (currentPassword === newPassword) redirect(`${target}&issue=password-same`);
  const response = await execute('/auth/password', {
    method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!response?.ok) redirect(`${target}&issue=${response?.status === 403 ? 'current-password' : issue(response, 'password')}`);
  (await cookies()).delete(sessionCookie);
  redirect('/?notice=password-changed');
}

export async function createProject(form: FormData) {
  const path = settingsPath('projects');
  const target = atDialog(path, 'project-create');
  const response = await execute('/projects', {
    method: 'POST',
    body: JSON.stringify({
      code: form.get('code'), name: form.get('name'), description: form.get('description'),
    }),
  });
  if (!response?.ok) redirect(`${target}&issue=${issue(response, 'project')}`);
  revalidatePath(path);
  redirect(`${target}&notice=project-created`);
}

export async function updateProject(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const response = await execute(endpoint, {
    method: 'PATCH',
    body: JSON.stringify({ name: form.get('name'), description: form.get('description') }),
  });
  if (!response?.ok) redirect(`${atDialog(query, 'project-edit')}&issue=${issue(response, 'project')}`);
  redirect(`${atDialog(query, 'project-edit')}&notice=project-saved`);
}

function operationsTarget(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const month = String(form.get('month') ?? '');
  const task = String(form.get('task') ?? '');
  const target = `${query}&section=operations${budgetMonthPattern.test(month) ? `&month=${month}` : ''}`
    + (task ? `&task=${encodeURIComponent(task)}` : '');
  return { target, endpoint, month };
}

export async function saveModelRate(form: FormData) {
  const { target: operations, endpoint } = operationsTarget(form);
  const target = atDialog(operations, 'rates');
  const model = String(form.get('model') ?? '').trim();
  if (!/^[\w.-]{1,100}$/.test(model)) redirect(`${target}&issue=model-rate#operations`);
  const response = await execute(`${endpoint}/operations/rates/${encodeURIComponent(model)}`, { method: 'PUT', body: JSON.stringify({
    inputUsdPerMillion: form.get('inputUsdPerMillion'), cachedInputUsdPerMillion: form.get('cachedInputUsdPerMillion'),
    outputUsdPerMillion: form.get('outputUsdPerMillion'), sourceUrl: form.get('sourceUrl'),
  }) });
  if (!response?.ok) redirect(`${target}&issue=${issue(response, 'model-rate')}#operations`);
  redirect(`${target}&notice=rate-saved#operations`);
}

export async function saveMonthlyBudget(form: FormData) {
  const { endpoint, target: operations, month } = operationsTarget(form);
  const target = atDialog(operations, 'budget');
  const amount = String(form.get('amountUsd') ?? '').trim();
  if (!budgetMonthPattern.test(month) || (amount && (!budgetAmountPattern.test(amount) || Number(amount) <= 0))) {
    redirect(`${target}&issue=monthly-budget#budget-heading`);
  }
  const response = await execute(`${endpoint}/operations/budget/${month}`, {
    method: 'PUT', body: JSON.stringify({ amountUsd: amount || null }),
  });
  if (!response?.ok) redirect(`${target}&issue=${issue(response, 'monthly-budget')}#budget-heading`);
  redirect(`${target}&notice=budget-saved#budget-heading`);
}

export async function archiveProject(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const response = await execute(`${endpoint}/archive`, { method: 'POST' });
  if (!response?.ok) redirect(`${atDialog(query, 'project-archive')}&issue=${issue(response, 'project')}`);
  redirect(`${query}&notice=project-archived`);
}

export async function createUser(form: FormData) {
  const path = settingsPath('accounts');
  const target = atDialog(path, 'accounts');
  const response = await execute('/users', {
    method: 'POST',
    body: JSON.stringify({
      name: form.get('name'), email: form.get('email'), password: form.get('password'),
    }),
  });
  if (!response?.ok) redirect(`${target}&issue=${issue(response, 'user')}`);
  revalidatePath(path);
  redirect(`${target}&notice=user-created`);
}

export async function changeMember(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const userId = encodeURIComponent(String(form.get('userId') ?? ''));
  const role = form.get('role');
  const response = await execute(`${endpoint}/members/${userId}`, role === 'remove'
    ? { method: 'DELETE' }
    : { method: 'PUT', body: JSON.stringify({ role }) });
  if (!response?.ok) redirect(`${atDialog(query, 'project-members')}&issue=${issue(response, 'member')}`);
  redirect(`${atDialog(query, 'project-members')}&notice=member-saved`);
}

export async function bindRepository(form: FormData) {
  const { query: projectQuery, endpoint } = projectPath(form);
  const query = `${projectQuery}&section=repositories`;
  const response = await execute(`${endpoint}/repositories`, {
    method: 'POST',
    body: JSON.stringify({
      installationId: form.get('installationId'),
      repositoryId: form.get('repositoryId'),
      defaultBranch: form.get('defaultBranch'),
    }),
  });
  if (!response?.ok) {
    const chosen = String(form.get('installationId') ?? '');
    const installation = /^[0-9]+$/.test(chosen) ? `&installation=${chosen}` : '';
    redirect(`${atDialog(query, 'repo-bind')}${installation}&issue=${issue(response, 'repository')}`);
  }
  redirect(`${atDialog(query, 'repo-bind')}&notice=repository-bound`);
}

export async function updateRepositoryChecks(form: FormData) {
  const { query: projectQuery, endpoint } = projectPath(form);
  const query = `${projectQuery}&section=repositories`;
  const repositoryId = form.get('repositoryId');
  if (!isWorkerId(repositoryId)) redirect(query + '&issue=verification');
  const target = atDialog(query, `checks:${repositoryId}`);
  let checks: unknown;
  let independentChecks: unknown;
  try {
    checks = JSON.parse(String(form.get('checks') ?? ''));
    const rawIndependent = form.get('independentChecks');
    if (typeof rawIndependent === 'string') independentChecks = JSON.parse(rawIndependent);
  } catch {
    redirect(target + '&issue=verification');
  }
  const response = await execute(`${endpoint}/repositories/${repositoryId}/checks`, {
    method: 'PATCH', body: JSON.stringify({ checks, independentChecks, autoDraftPr: form.get('autoDraftPr') === 'on' }),
  });
  if (!response?.ok) redirect(`${target}&issue=${issue(response, 'verification')}`);
  redirect(`${target}&notice=checks-saved`);
}

function taskPath(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const id = String(form.get('taskId') ?? '');
  if (id && !/^[a-f0-9-]{36}$/i.test(id)) redirect(query);
  const taskQuery = `${query}&section=${form.get('section') === 'approvals' ? 'approvals' : 'tasks'}`;
  return { query: id ? `${taskQuery}&task=${id}` : taskQuery, endpoint: `${endpoint}/tasks${id ? `/${id}` : ''}`, id };
}

function taskIssue(response: Response | null) {
  return response?.status === 409 ? 'task-conflict' : issue(response, 'task');
}

async function hasPendingDecisions(response: Response | null) {
  return response?.status === 409 && (await response.json().catch(() => null))?.code === 'pending-decisions';
}

export async function startAgentPlan(form: FormData) {
  const { query: projectQuery, endpoint } = projectPath(form);
  const query = `${projectQuery}&section=tasks`;
  const response = await execute(`${endpoint}/agent-plans`, {
    method: 'POST', body: JSON.stringify({
      request: form.get('request'), repositoryId: form.get('repositoryId'), requirementId: form.get('requirementId') || null,
      knowledgeVersionIds: form.getAll('knowledgeVersionIds'),
    }),
  });
  if (!response?.ok) redirect(`${atDialog(query, 'plan')}&issue=${response?.status === 503 ? 'agent-config'
    : response?.status === 409 ? 'agent-plan' : issue(response, 'agent-plan')}`);
  const plan = await response.json() as AgentPlan;
  redirect(`${query}&task=${plan.taskId}#task-detail`);
}

export async function saveKnowledgeVersion(form: FormData) {
  const { query: projectQuery, endpoint } = projectPath(form);
  const task = form.get('taskId');
  const query = projectQuery + (isWorkerId(task) ? `&task=${task}` : '');
  const entryId = form.get('entryId');
  const repositoryId = form.get('evidenceRepositoryId');
  const runId = form.get('evidenceRunId');
  const path = isWorkerId(entryId) ? `/${entryId}/versions` : '';
  const target = `${query}&section=knowledge&knowledgeHistory=1${path ? `&knowledgeEntry=${entryId}` : ''}`;
  const response = await execute(`${endpoint}/knowledge${path}`, {
    method: 'POST', body: JSON.stringify({
      title: form.get('title'), kind: form.get('knowledgeKind'), excerpt: form.get('excerpt'),
      sourceUrl: form.get('sourceUrl'), sourceRevision: form.get('sourceRevision'), versionNote: form.get('versionNote'),
      ...(repositoryId && { designEvidence: { repositoryId, implementationCommit: form.get('implementationCommit'),
        reportUrl: form.get('reportUrl'), ...(runId && { runId }) } }),
    }),
  });
  if (!response?.ok) redirect(`${target}&knowledgeResult=${issue(response, 'invalid')}#project-knowledge`);
  const created = await response.json() as { id: string; entryId: string };
  revalidatePath('/');
  redirect(`${query}&section=knowledge&knowledgeHistory=1&knowledgeEntry=${created.entryId}&knowledgeVersion=${created.id}&knowledgeResult=saved#project-knowledge`);
}

export async function updateKnowledgeVersion(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const task = form.get('taskId');
  const entryId = form.get('entryId');
  const versionId = form.get('versionId');
  const operation = form.get('operation');
  const origin = `${query}${isWorkerId(task) ? `&task=${task}` : ''}&section=knowledge&knowledgeHistory=1`;
  if (!isWorkerId(entryId) || !isWorkerId(versionId)) redirect(`${origin}#project-knowledge`);
  const target = `${origin}&knowledgeEntry=${entryId}&knowledgeVersion=${versionId}`;
  const route = `${endpoint}/knowledge/${entryId}`;
  const decision = operation === 'approved' || operation === 'rejected';
  if (!decision && operation !== 'activate' && operation !== 'retire') redirect(`${target}#project-knowledge`);
  const response = await execute(decision ? `${route}/versions/${versionId}/decision` : `${route}/active-version`, {
    method: 'PUT', body: JSON.stringify(decision ? { decision: operation }
      : operation === 'retire' ? { versionId: null, expectedVersionId: versionId } : { versionId }),
  });
  if (!response?.ok) redirect(`${target}&knowledgeResult=${issue(response, 'invalid')}#project-knowledge`);
  revalidatePath('/');
  redirect(`${target}&knowledgeResult=${operation}#project-knowledge`);
}

export async function registerRequirement(form: FormData) {
  const { endpoint } = projectPath(form);
  const { query } = taskPath(form);
  const response = await execute(`${endpoint}/requirements`, {
    method: 'POST', body: JSON.stringify({
      title: form.get('title'), referenceUrl: form.get('referenceUrl'), excerpt: form.get('excerpt'),
    }),
  });
  if (!response?.ok) {
    const result = issue(response, response && response.status >= 500 ? 'offline' : 'requirement');
    redirect(`${atDialog(query, 'requirements')}&requirementResult=${result}#task-requirements`);
  }
  redirect(`${atDialog(query, 'requirements')}&requirementResult=registered#task-requirements`);
}

export async function retireRequirement(form: FormData) {
  const { endpoint } = projectPath(form);
  const { query } = taskPath(form);
  const id = form.get('requirementId');
  if (!isWorkerId(id)) redirect(`${atDialog(query, 'requirements')}&requirementResult=requirement#task-requirements`);
  const response = await execute(`${endpoint}/requirements/${id}`, { method: 'DELETE' });
  if (!response?.ok) {
    const result = issue(response, response && response.status >= 500 ? 'offline' : 'requirement');
    redirect(`${atDialog(query, 'requirements')}&requirementResult=${result}#task-requirements`);
  }
  redirect(`${atDialog(query, 'requirements')}&requirementResult=retired#task-requirements`);
}

export async function retryAgentPlan(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  if (!id) redirect(query);
  const response = await execute(`${endpoint}/agent-plan/retry`, { method: 'POST' });
  if (!response?.ok) redirect(`${query}&issue=${response?.status === 503 ? 'agent-config' : issue(response, 'agent-plan')}`);
  redirect(`${query}#task-detail`);
}

export async function retryExecutionQa(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  const runId = form.get('runId');
  if (!id || !isWorkerId(runId)) redirect(query);
  const response = await execute(`${endpoint}/executions/${runId}/qa/retry`, { method: 'POST' });
  if (!response?.ok) redirect(`${query}&issue=${response?.status === 503 ? 'agent-config' : issue(response, 'agent-qa')}`);
  redirect(`${query}#task-detail`);
}

export async function updateAgent(form: FormData) {
  const { query: projectQuery, endpoint } = projectPath(form);
  const query = `${projectQuery}&section=agents`;
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
  const target = atDialog(query, `agent:${role}`);
  if (!response?.ok) redirect(`${target}&issue=${response?.status === 409 ? 'agent-skill-binding' : issue(response, 'agent-settings')}`);
  redirect(`${target}&notice=agent-saved#agent-registry`);
}

export async function updateSkill(form: FormData) {
  const { query: projectQuery, endpoint } = projectPath(form);
  const query = `${projectQuery}&section=agents`;
  const id = form.get('skillId');
  if (id && !isWorkerId(id)) redirect(query);
  const toggle = id && form.get('operation') === 'toggle';
  const path = id ? `/${id}${toggle ? '' : '/versions'}` : '';
  const body = toggle ? { enabled: form.get('enabled') === 'true' }
    : { name: form.get('name'), instructions: form.get('instructions') };
  const response = await execute(`${endpoint}/agent-registry/skills${path}`, {
    method: toggle ? 'PUT' : 'POST', body: JSON.stringify(body),
  });
  if (!response?.ok) redirect(`${atDialog(query, id ? `skill:${id}` : 'skill-create')}&issue=${issue(response, 'agent-settings')}`);
  const saved = await response.json() as { id: string; version?: number; enabled: boolean };
  const target = `${atDialog(query, `skill:${saved.id}`)}&skill=${saved.id}`;
  const fragment = `#skill-${saved.id}`;
  if (toggle) redirect(`${target}&skillResult=${saved.enabled ? 'enabled' : 'disabled'}${fragment}`);
  redirect(`${target}&skillVersion=${saved.version}&skillResult=version-created${fragment}-v${saved.version}`);
}

export async function reviewSkillVersion(form: FormData) {
  const { query, endpoint } = projectPath(form);
  const id = form.get('skillId');
  const version = Number(form.get('version'));
  const step = form.get('step');
  if (!isWorkerId(id) || !Number.isSafeInteger(version) || version < 1 || version > 2147483647
    || (step !== 'evaluation' && step !== 'decision')) redirect(`${query}#agent-registry`);
  const decision = form.get('decision');
  const body = step === 'evaluation' ? { result: form.get('result'), evidence: form.get('evidence') } : { decision };
  const response = await execute(`${endpoint}/agent-registry/skills/${id}/versions/${version}/${step}`, {
    method: 'PUT', body: JSON.stringify(body),
  });
  if (response?.status === 401 || response?.status === 403) {
    redirect(`${query}&issue=${issue(response, 'agent-settings')}#agent-registry`);
  }
  const result = response?.ok ? (step === 'evaluation' ? 'evaluated' : decision === 'approved' ? 'approved' : 'rejected')
    : response?.status === 409 ? 'review-conflict' : 'review-failed';
  redirect(`${atDialog(`${query}&section=agents`, `skill:${id}`)}&skill=${id}&skillVersion=${version}&skillResult=${result}#skill-${id}-v${version}`);
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
  if (!response?.ok) redirect(`${id ? atDialog(query, 'task-edit') : `${query}&create=task`}&issue=${taskIssue(response)}`);
  const task = await response.json() as { id: string };
  redirect(`${id ? `${atDialog(query, 'task-edit')}&notice=task-saved` : `${query}&task=${task.id}&notice=task-created`}#task-detail`);
}

export async function transitionTask(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  if (!id) redirect(query);
  const status = form.get('status');
  const response = await execute(`${endpoint}/transition`, {
    method: 'POST', body: JSON.stringify({ status, developerRole: form.get('developerRole') || null }),
  });
  if (await hasPendingDecisions(response)) redirect(`${query}&issue=pending-decisions#task-decisions`);
  if (!response?.ok) {
    const confirmation = status === 'READY' ? 'task-approve' : status === 'REJECTED' ? 'task-reject' : status === 'CANCELLED' ? 'task-cancel' : null;
    const errorTarget = confirmation && form.get('confirmTransition') === '1' ? atDialog(query, confirmation) : query;
    redirect(`${errorTarget}&issue=${taskIssue(response)}#task-detail`);
  }
  redirect(`${query}&notice=task-transitioned#task-detail`);
}

export async function submitTaskDecisions(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  if (!id) redirect(query);
  const answers = [...form.entries()].flatMap(([key, answer]) => key.startsWith('decision:')
    ? [{ id: key.slice('decision:'.length), answer }] : []);
  const response = await execute(`${endpoint}/decisions`, { method: 'POST', body: JSON.stringify({ answers }) });
  if (!response?.ok) redirect(`${query}&issue=${response?.status === 409 ? 'decision-submit' : issue(response, 'decision-submit')}#task-decisions`);
  redirect(`${query}&notice=decisions-submitted#task-decisions`);
}

export async function archiveTask(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  if (!id) redirect(query);
  const response = await execute(`${endpoint}/archive`, { method: 'POST' });
  if (!response?.ok) redirect(`${atDialog(query, 'task-archive')}&issue=${taskIssue(response)}`);
  redirect(`${query}&notice=task-archived#task-detail`);
}

export async function startExecution(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  if (!id) redirect(query);
  const workerId = form.get('workerId') || null;
  if (workerId && !isWorkerId(workerId)) redirect(`${atDialog(query, 'dispatch')}&issue=worker-assignment#task-detail`);
  const revisionOf = form.get('revisionOf') || null;
  if (revisionOf && !isWorkerId(revisionOf)) redirect(`${atDialog(query, 'dispatch')}&issue=revision#task-detail`);
  const response = await execute(`${endpoint}/executions`, { method: 'POST', body: JSON.stringify({ workerId, revisionOf }) });
  if (await hasPendingDecisions(response)) redirect(`${query}&issue=pending-decisions#task-decisions`);
  if (!response?.ok && revisionOf) redirect(`${atDialog(query, 'dispatch')}&issue=revision#task-detail`);
  if (!response?.ok) redirect(`${atDialog(query, 'dispatch')}&issue=${workerId && response?.status === 409 ? 'worker-assignment' : taskIssue(response)}`);
  redirect(`${query}&notice=execution-started#task-detail`);
}

export async function changeExecutionWorker(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  const runId = form.get('runId');
  const workerId = form.get('workerId') || null;
  if (!id || !isWorkerId(runId)) redirect(query);
  if (workerId && !isWorkerId(workerId)) redirect(`${atDialog(query, 'worker-assignment')}&issue=worker-assignment#task-detail`);
  const response = await execute(`${endpoint}/executions/${runId}/worker`, { method: 'POST', body: JSON.stringify({ workerId }) });
  if (!response?.ok) redirect(`${atDialog(query, 'worker-assignment')}&issue=${response?.status === 409 ? 'worker-assignment' : issue(response, 'worker-assignment')}#task-detail`);
  redirect(`${atDialog(query, 'worker-assignment')}&notice=worker-assigned#task-detail`);
}

export async function stopExecution(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  const runId = form.get('runId');
  if (!id || !isWorkerId(runId)) redirect(query);
  const response = await execute(`${endpoint}/executions/${runId}/cancel`, { method: 'POST' });
  if (!response?.ok) redirect(`${atDialog(query, 'execution-stop')}&issue=${taskIssue(response)}#task-detail`);
  redirect(`${query}#task-detail`);
}

export async function reviewExecution(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  const runId = form.get('runId');
  if (!id || !isWorkerId(runId)) redirect(query);
  const response = await execute(`${endpoint}/executions/${runId}/review`, {
    method: 'POST', body: JSON.stringify({ decision: form.get('decision'), comment: form.get('comment') }),
  });
  if (!response?.ok) redirect(`${atDialog(query, 'review')}&issue=${await verificationIssue(response, 'review')}#task-detail`);
  redirect(`${query}&notice=execution-reviewed#task-detail`);
}

export async function addExecutionEvidence(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  const runId = form.get('runId');
  if (!id || !isWorkerId(runId)) redirect(query);
  const checkName = form.get('checkName');
  const response = await execute(`${endpoint}/executions/${runId}/evidence`, {
    method: 'POST', body: JSON.stringify({
      patchHash: form.get('patchHash'), summary: form.get('summary'), url: form.get('url'),
      ...(checkName && { check: { name: checkName, status: form.get('checkStatus'), environment: form.get('environment'), source: 'archive' } }),
    }),
  });
  if (!response?.ok) redirect(`${atDialog(query, form.get('checkName') ? 'independent-evidence' : 'evidence')}&issue=${issue(response, 'evidence')}#task-detail`);
  const saved = await response.json() as { recordedAt: string };
  revalidatePath('/');
  redirect(`${query}&notice=execution-evidence-saved&evidenceAt=${encodeURIComponent(saved.recordedAt)}#task-detail`);
}

async function verificationIssue(response: Response | null, fallback: string) {
  const detail = response?.status === 409 ? await response.json().catch(() => null) : null;
  return detail?.code === 'quality_gate' ? 'quality-gate' : issue(response, fallback);
}

export async function publishExecution(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  const runId = form.get('runId');
  if (!id || !isWorkerId(runId)) redirect(query);
  const response = await execute(`${endpoint}/executions/${runId}/delivery`, { method: 'POST' });
  if (!response?.ok) redirect(`${atDialog(query, 'publish')}&issue=${response?.status === 503 ? 'github-delivery-config' : await verificationIssue(response, 'delivery')}#task-detail`);
  redirect(`${query}#task-detail`);
}

export async function refreshDelivery(form: FormData) {
  const { query, endpoint, id } = taskPath(form);
  const runId = form.get('runId');
  if (!id || !isWorkerId(runId)) redirect(query);
  const response = await execute(`${endpoint}/executions/${runId}/delivery/refresh`, {
    method: 'POST', signal: AbortSignal.timeout(18000),
  });
  if (!response?.ok) redirect(`${query}&issue=${issue(response, 'delivery-refresh')}#task-detail`);
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
  const lifetime = form.get('lifetimeHours');
  const lifetimeHours = lifetime === null ? undefined : Number(lifetime);
  let response: Response | null;
  if (operation === 'create') {
    response = await execute(collection, { method: 'POST', body: JSON.stringify({ name: form.get('name'), lifetimeHours }) });
  } else if (isWorkerId(workerId) && operation === 'rotate') {
    response = await execute(`${collection}/${workerId}/credential`, { method: 'POST', body: JSON.stringify({ lifetimeHours }) });
  } else if (isWorkerId(workerId) && (operation === 'grant' || operation === 'revoke')) {
    response = await execute(`${collection}/${workerId}`, { method: operation === 'grant' ? 'PUT' : 'DELETE' });
  } else {
    return { error: '请输入有效的 Worker ID。' };
  }
  if (!response?.ok) return { error: '操作失败，请检查项目权限和 Worker 状态。' };
  if (operation === 'create' || operation === 'rotate') {
    return { credential: await response.json() as WorkerCredential };
  }
  return { notice: operation === 'grant' ? 'Worker 已获项目授权。' : 'Worker 的项目权限已撤回。' };
}
