import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { URL } from 'node:url';
import { AgentPlanningService } from '../apps/api/src/agent-planning.ts';
import { AgentRegistryService } from '../apps/api/src/agent-registry.ts';
import { AuthService } from '../apps/api/src/auth.ts';
import { Database } from '../apps/api/src/database.ts';
import { ExecutionsService } from '../apps/api/src/executions.ts';
import { GitHubApp } from '../apps/api/src/github.ts';
import { ProjectsService } from '../apps/api/src/projects.ts';
import { TasksService } from '../apps/api/src/tasks.ts';

const api = new URL(process.env.ADO_VERIFY_API_URL ?? 'http://127.0.0.1:3101');
const web = new URL(process.env.ADO_VERIFY_WEB_URL ?? 'http://web:3000');
const { ADO_BOOTSTRAP_EMAIL: email, ADO_BOOTSTRAP_PASSWORD: password } = process.env;
assert(email && password, 'Configure a bootstrap account for the integration check');
assert(!process.env.ADO_AGENT_API_KEY, 'Run the fixture without an external planning provider');
const db = new Database();
const auth = new AuthService(db);
const projects = new ProjectsService(db, auth);
const tasks = new TasksService(db, projects);
const registry = new AgentRegistryService(db, projects);
const executions = new ExecutionsService(db, projects, tasks, new GitHubApp());
const modelCalls = [];
const outputs = {
  PROJECT_DIRECTOR: { objective: 'Create a settings page', constraints: ['Use the existing repository'] },
  PRODUCT_MANAGER: {
    title: 'Settings page', userStory: 'As a user I can view settings', requirements: ['Show the saved value'],
    acceptanceCriteria: ['The page displays the saved value'],
  },
  ARCHITECT: {
    developer: 'FRONTEND_DEVELOPER', steps: ['Add the route and wire the existing data source'],
    risks: ['Missing data state'], testApproach: ['Exercise the page with and without saved data'],
  },
};
let failProduct = true;
let resumeCancelledCall;
let startedCancelledCall;
const cancelledCallStarted = new Promise((resolve) => { startedCancelledCall = resolve; });
const planning = new AgentPlanningService(db, projects, tasks, registry, {
  available: () => true,
  defaultModel: () => 'fixture-model',
  async generate(role, agent, input) {
    modelCalls.push({ role, agent, input });
    if (input.request === 'Cancel during inference') {
      await new Promise((resolve) => { resumeCancelledCall = resolve; startedCancelledCall(); });
    }
    if (role === 'PRODUCT_MANAGER' && failProduct) {
      failProduct = false;
      return { ...outputs.PRODUCT_MANAGER, acceptanceCriteria: [] };
    }
    return outputs[role];
  },
});

async function request(path, { token, method = 'GET', body, status = 200 } = {}) {
  const response = await globalThis.fetch(new URL(path, api), {
    method, headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, status, `${method} ${path} returned ${response.status}`);
  if (status < 300 && status !== 204) return response.json();
}

try {
  const { token } = await request('/auth/session', { method: 'POST', body: { email, password } });
  const account = await request('/auth/session', { token });
  const suffix = randomBytes(5).toString('hex');
  const project = (prefix) => request('/projects', { method: 'POST', status: 201, token,
    body: { code: `${prefix}-${suffix}`, name: prefix } });
  const first = await project('AGENT');
  const second = await project('AGENT-OTHER');
  const prefix = `/projects/${first.id}`;
  const registryPath = `${prefix}/agent-registry`;
  const developerPath = `${registryPath}/agents/FRONTEND_DEVELOPER`;
  const viewer = await request('/users', { token, status: 201, method: 'POST',
    body: { email: `viewer-${suffix}@example.test`, name: 'Planning viewer', password } });
  const { token: viewerToken } = await request('/auth/session', {
    method: 'POST', body: { email: viewer.email, password },
  });
  await request(registryPath, { status: 401 });
  await request(registryPath, { token: viewerToken, status: 404 });
  await request(`${prefix}/members/${viewer.id}`, { token, method: 'PUT', body: { role: 'viewer' }, status: 204 });
  assert.equal((await request(registryPath, { token: viewerToken })).agents.length, 8);
  await request(developerPath, { token: viewerToken, method: 'PUT', body: { enabled: false }, status: 403 });

  const skill = await request(`${registryPath}/skills`, {
    token, method: 'POST', status: 201, body: { name: 'Interface guidelines', instructions: 'Use the shared UI components' },
  });
  const skillV2 = await request(`${registryPath}/skills/${skill.id}/versions`, {
    token, method: 'POST', status: 201, body: { instructions: 'Use the shared accessible UI components' },
  });
  assert.equal(skillV2.version, 2);
  const reference = { id: skill.id, version: skillV2.version };
  const config = { instructions: 'Cover empty states', model: 'fixture-codex', skills: [reference] };
  await request(`/projects/${second.id}/agent-registry/agents/FRONTEND_DEVELOPER/versions`, {
    token, method: 'POST', status: 404, body: config,
  });
  const published = await request(`${developerPath}/versions`, { token, method: 'POST', status: 201, body: config });
  assert.equal(published.version, 2);
  await request(`${registryPath}/agents/PRODUCT_MANAGER/versions`, {
    token, method: 'POST', status: 201, body: { model: 'fixture-pm', skills: [reference] },
  });

  const { rows: [repo] } = await db.pool.query(
    `INSERT INTO repositories (project_id, github_repository_id, owner, repo_name, repository_url, default_branch, installation_id)
     VALUES ($1, $2, 'test', 'planning-fixture', 'https://github.com/test/planning-fixture', 'main', 1) RETURNING id`,
    [first.id, Number.parseInt(suffix, 16)],
  );
  const input = { request: 'Add a settings page', repositoryId: repo.id };
  await request(`${prefix}/agent-plans`, { token: viewerToken, method: 'POST', body: input, status: 403 });
  await request(`/projects/${second.id}/agent-plans`, { token, method: 'POST', body: input, status: 404 });
  await request(`${prefix}/agent-plans`, { token, method: 'POST', body: input, status: 503 });

  const directStart = () => planning.start(account, first.id, input);
  await request(`${registryPath}/agents/ARCHITECT`, { token, method: 'PUT', body: { enabled: false } });
  await assert.rejects(directStart(), /disabled/);
  await request(`${registryPath}/agents/ARCHITECT`, { token, method: 'PUT', body: { enabled: true } });
  const queued = await directStart();
  const taskPath = `${prefix}/tasks/${queued.taskId}`;
  const planPath = `${taskPath}/agent-plan`;
  assert.equal(queued.state, 'queued');
  await request(taskPath, { token, method: 'PATCH', body: { title: 'Replace plan' }, status: 409 });
  await request(`${taskPath}/executions`, { token, method: 'POST', status: 409 });

  await request(developerPath, { token, method: 'PUT', body: { activeVersion: 1 } });
  await request(`${registryPath}/skills/${skill.id}`, { token, method: 'PUT', body: { enabled: false } });
  assert.equal(await planning.runNext(), true);
  assert.equal(await planning.runNext(), true);
  const { plan: failed } = await request(planPath, { token });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.stage, 'PRODUCT_MANAGER');
  assert.equal(failed.steps.length, 1);
  await request(`${planPath}/retry`, { token: viewerToken, method: 'POST', status: 403 });
  assert.equal((await planning.retry(account, first.id, queued.taskId)).state, 'queued');
  // A replacement processor can recover an expired claim after a restart.
  await db.pool.query(
    `UPDATE task_agent_plans SET state = 'running', lease_id = gen_random_uuid(),
      lease_expires_at = now() - interval '1 second' WHERE task_id = $1`, [queued.taskId],
  );
  assert.equal(await planning.runNext(), true);
  assert.equal(await planning.runNext(), true);
  assert.equal(await planning.runNext(), false);
  const { plan: complete } = await request(planPath, { token });
  assert.equal(complete.state, 'completed');
  assert.equal(complete.stage, null);
  assert.deepEqual(modelCalls.map(({ role }) => role), ['PROJECT_DIRECTOR', 'PRODUCT_MANAGER', 'PRODUCT_MANAGER', 'ARCHITECT']);
  assert.equal(modelCalls[2].agent.model, 'fixture-pm');
  assert.equal(modelCalls[2].agent.skills[0].version, 2);
  assert.equal(modelCalls[3].input.priorSteps.length, 2);
  const proposed = await request(taskPath, { token });
  assert.equal(proposed.status, 'WAITING_APPROVAL');
  assert.equal(proposed.title, outputs.PRODUCT_MANAGER.title);
  assert.deepEqual(proposed.acceptanceCriteria, outputs.PRODUCT_MANAGER.acceptanceCriteria);
  await request(`${taskPath}/executions`, { token, method: 'POST', status: 409 });

  const rendered = await globalThis.fetch(new URL(`/?project=${first.id}&task=${queued.taskId}`, web), {
    headers: { Cookie: `ado_session=${token}` }, signal: globalThis.AbortSignal.timeout(30_000),
  });
  assert.equal(rendered.status, 200);
  const html = await rendered.text();
  assert(html.includes('用 Agent 规划需求') && html.includes('批准方案') && html.includes('实施步骤') && html.includes('Agent 与 Skill'));

  await request(`${taskPath}/transition`, { token, method: 'POST', body: { status: 'READY' } });
  const run = await request(`${taskPath}/executions`, { token, method: 'POST', status: 201 });
  const credential = await request(`${prefix}/workers`, {
    token, method: 'POST', status: 201, body: { name: 'Planning handoff fixture' },
  });
  const { rows: [worker] } = await db.pool.query(
    `UPDATE workers SET connection_id = gen_random_uuid(), capabilities = '{"codexVersion":"0.170.0"}'
     WHERE id = $1 RETURNING id AS "workerId", credential_hash AS hash, connection_id AS "connectionId"`, [credential.workerId],
  );
  const offer = await executions.claim(worker);
  assert.equal(offer?.id, run.id);
  assert.deepEqual(offer.development.plan, outputs.ARCHITECT);
  assert.equal(offer.development.agent.version, 2);
  assert.equal(offer.development.agent.model, config.model);
  assert.equal(offer.development.agent.skills[0].instructions, skillV2.instructions);
  await request(`${taskPath}/executions/${run.id}/cancel`, { token, method: 'POST', status: 204 });
  assert.deepEqual(await executions.record(worker, { runId: run.id, sequence: 1, kind: 'cancelled', payload: {} }),
    { stop: false, accepted: true });

  const cancelled = await planning.start(account, first.id, { ...input, request: 'Cancel during inference' });
  const inFlight = planning.runNext();
  await cancelledCallStarted;
  const cancelledPath = `${prefix}/tasks/${cancelled.taskId}`;
  try {
    await request(`${cancelledPath}/transition`, { token, method: 'POST', body: { status: 'CANCELLED' } });
  } finally {
    resumeCancelledCall();
    await inFlight;
  }
  const { plan } = await request(`${cancelledPath}/agent-plan`, { token });
  assert.equal(plan.state, 'cancelled');
  assert.deepEqual(plan.steps, []);
  assert.equal((await request(cancelledPath, { token })).status, 'CANCELLED');

  process.stdout.write('Agent registry, planning recovery, approval and Worker handoff verified.\n');
} finally {
  await db.onModuleDestroy();
}
