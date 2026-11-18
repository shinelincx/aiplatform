import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import process from 'node:process';
import { URL } from 'node:url';
import { AgentPlanningService } from '../apps/api/src/agent-planning.ts';
import { AgentRegistryService } from '../apps/api/src/agent-registry.ts';
import { ArtifactStore } from '../apps/api/src/artifacts.ts';
import { AuthService } from '../apps/api/src/auth.ts';
import { Database } from '../apps/api/src/database.ts';
import { DeliveriesService } from '../apps/api/src/deliveries.ts';
import { ExecutionQaService } from '../apps/api/src/execution-qa.ts';
import { ExecutionsService } from '../apps/api/src/executions.ts';
import { pushCandidate } from '../apps/api/src/git-delivery.ts';
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
const github = new GitHubApp();
const deliveries = new DeliveriesService(db, tasks, projects, github, new ArtifactStore(), pushCandidate);
const executions = new ExecutionsService(db, projects, tasks, github, deliveries);
const modelCalls = [];
const qaCalls = [];
const modelReply = (agent, output) => ({
  output, usage: { model: `${agent.model}-resolved`, inputTokens: 20, cachedInputTokens: 5, outputTokens: 8 },
});
const qa = new ExecutionQaService(db, projects, tasks, new ArtifactStore(), {
  available: () => true,
  async generate(agent, input) {
    qaCalls.push({ agent, input });
    if (qaCalls.length === 1) throw new Error('Fixture transient error');
    return modelReply(agent, {
      recommendation: 'ready', testCases: ['Check the empty state'], findings: ['The settings route renders the saved value'],
    });
  },
});
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
      return modelReply(agent, { ...outputs.PRODUCT_MANAGER, acceptanceCriteria: [] });
    }
    return modelReply(agent, outputs[role]);
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
  const overviewPath = `${prefix}/operations/overview`;
  const requirementsPath = `${prefix}/requirements`;
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
  const approvedContent = { title: 'Approved settings requirement', excerpt: 'The settings page renders the saved value and covers the empty state.' };
  const requirementBody = { ...approvedContent, referenceUrl: 'https://github.com/test/planning-fixture/issues/1' };
  await request(requirementsPath, { token: viewerToken, method: 'POST', status: 403, body: requirementBody });
  await request(requirementsPath, { token, method: 'POST', status: 400, body: { ...requirementBody, referenceUrl: 'javascript:alert(1)' } });
  const requirement = await request(requirementsPath, { token, method: 'POST', status: 201, body: requirementBody });
  const foreignRequirement = await request(`/projects/${second.id}/requirements`, {
    token, method: 'POST', status: 201, body: { ...requirementBody, title: 'Other project requirement' },
  });
  assert.deepEqual((await request(requirementsPath, { token: viewerToken })).map(({ id }) => id), [requirement.id]);
  await request(`/projects/${second.id}/requirements`, { token: viewerToken, status: 404 });
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
  await request(`${registryPath}/agents/QA_ENGINEER/versions`, {
    token, method: 'POST', status: 201, body: { model: 'fixture-qa', instructions: 'Verify empty states' },
  });

  const { rows: [repo] } = await db.pool.query(
    `INSERT INTO repositories (project_id, github_repository_id, owner, repo_name, repository_url, default_branch, installation_id)
     VALUES ($1, $2, 'test', 'planning-fixture', 'https://github.com/test/planning-fixture', 'main', 1) RETURNING id`,
    [first.id, Number.parseInt(suffix, 16)],
  );
  const input = { request: 'Add a settings page', repositoryId: repo.id, requirementId: requirement.id };
  await request(`${prefix}/agent-plans`, { token: viewerToken, method: 'POST', body: input, status: 403 });
  await request(`/projects/${second.id}/agent-plans`, { token, method: 'POST', body: input, status: 404 });
  await request(`${prefix}/agent-plans`, { token, method: 'POST', body: input, status: 503 });

  const directStart = () => planning.start(account, first.id, input);
  await assert.rejects(planning.start(account, first.id, { ...input, requirementId: foreignRequirement.id }), /not found/i);
  await request(`${registryPath}/agents/ARCHITECT`, { token, method: 'PUT', body: { enabled: false } });
  await assert.rejects(directStart(), /disabled/);
  await request(`${registryPath}/agents/ARCHITECT`, { token, method: 'PUT', body: { enabled: true } });
  const queued = await directStart();
  assert.equal(queued.requirement.id, requirement.id);
  await request(`${requirementsPath}/${requirement.id}`, { token, method: 'DELETE', status: 204 });
  assert.deepEqual(await request(requirementsPath, { token }), []);
  await assert.rejects(directStart(), /not found/i);
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
  assert.deepEqual((await request(overviewPath, { token })).alerts.map(({ taskId, kind }) => [taskId, kind]),
    [[queued.taskId, 'planning']]);
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
  assert.deepEqual(complete.requirement, requirement);
  assert(modelCalls.every(({ input: modelInput }) => JSON.stringify(modelInput.approvedRequirement) === JSON.stringify(approvedContent)));
  assert.deepEqual(modelCalls.map(({ role }) => role), ['PROJECT_DIRECTOR', 'PRODUCT_MANAGER', 'PRODUCT_MANAGER', 'ARCHITECT']);
  assert.equal(modelCalls[2].agent.model, 'fixture-pm');
  assert.equal(modelCalls[2].agent.skills[0].version, 2);
  assert.equal(modelCalls[3].input.priorSteps.length, 2);
  const proposed = await request(taskPath, { token });
  assert.equal(proposed.status, 'WAITING_APPROVAL');
  const proposedOverview = await request(overviewPath, { token: viewerToken });
  assert.equal(proposedOverview.agentsEnabled, 8);
  assert.equal(proposedOverview.tasks.approval, 1);
  assert.deepEqual(proposedOverview.alerts, []);
  assert.equal(proposed.title, outputs.PRODUCT_MANAGER.title);
  assert.deepEqual(proposed.acceptanceCriteria, outputs.PRODUCT_MANAGER.acceptanceCriteria);
  await request(`${taskPath}/executions`, { token, method: 'POST', status: 409 });

  const rendered = await globalThis.fetch(new URL(`/?project=${first.id}&task=${queued.taskId}`, web), {
    headers: { Cookie: `ado_session=${token}` }, signal: globalThis.AbortSignal.timeout(30_000),
  });
  assert.equal(rendered.status, 200);
  const html = await rendered.text();
  assert(html.includes('用 Agent 规划需求') && html.includes('批准方案') && html.includes('实施步骤') && html.includes('Agent 与 Skill'));
  assert(html.includes(requirement.referenceUrl) && html.includes('规划使用的批准摘录'));

  await request(`${taskPath}/transition`, { token, method: 'POST', body: { status: 'READY' } });
  await request(`${prefix}/repositories/${repo.id}/checks`, {
    token, method: 'PATCH', body: { checks: [{ name: 'unit', kind: 'unit', argv: ['node', '--test'] }] },
  });
  const run = await request(`${taskPath}/executions`, { token, method: 'POST', status: 201 });
  const credential = await request(`${prefix}/workers`, {
    token, method: 'POST', status: 201, body: { name: 'Planning handoff fixture' },
  });
  const { rows: [worker] } = await db.pool.query(
    `UPDATE workers SET connection_id = gen_random_uuid(), capabilities = '{"codexVersion":"0.170.0","verificationVersion":1}'
     WHERE id = $1 RETURNING id AS "workerId", credential_hash AS hash, connection_id AS "connectionId"`, [credential.workerId],
  );
  assert.equal(await executions.claim(worker), null, 'Planned QA requires an archive-capable Worker');
  await db.pool.query("UPDATE workers SET capabilities = capabilities || '{\"artifactVersion\":1}' WHERE id = $1", [worker.workerId]);
  const offer = await executions.claim(worker);
  assert.equal(offer?.id, run.id);
  assert.deepEqual(offer.development.plan, outputs.ARCHITECT);
  assert.equal(offer.development.agent.version, 2);
  assert.equal(offer.development.agent.model, config.model);
  assert.equal(offer.development.agent.skills[0].instructions, skillV2.instructions);
  assert.deepEqual(offer.development.requirement, approvedContent);
  assert.equal(offer.archivePatch, true);
  assert.equal(offer.development.qa, undefined);

  const runPath = `${taskPath}/executions/${run.id}`;
  const review = { token, method: 'POST', body: { decision: 'approved' } };
  const send = (sequence, kind, payload) => executions.record(worker, { runId: run.id, sequence, kind, payload });
  const patch = Buffer.from('diff --git a/settings.ts b/settings.ts\n--- a/settings.ts\n+++ b/settings.ts\n@@ -0,0 +1,3501 @@\n'
    + '+// Fixture settings patch\n'.repeat(3500) + '+export const savedValue = true;\n');
  const patchHash = createHash('sha256').update(patch).digest('hex');
  const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 };
  assert.equal((await send(1, 'thread', { threadId: 'fixture-qa-thread' })).accepted, true);
  assert.equal((await send(2, 'result', { attempt: 1, baseCommit: 'a'.repeat(40), patchHash, files: ['settings.ts'], usage })).accepted, true);
  const verification = { attempt: 1, patchHash, checks: [{ name: 'unit', status: 'passed', exitCode: 0, durationMs: 20 }] };
  assert.equal((await send(3, 'verification', verification)).accepted, false, 'QA requires the archived patch');
  const upload = await globalThis.fetch(new URL(`/worker-executions/${run.id}/artifact`, api), {
    method: 'PUT', body: patch,
    headers: { Authorization: `Bearer ${credential.workerId}.${credential.token}`, 'Content-Type': 'application/octet-stream' },
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  assert.equal(upload.status, 200);
  assert.equal((await send(3, 'verification', verification)).accepted, true);
  assert.equal((await send(3, 'verification', verification)).accepted, true);
  assert.equal((await request(`${taskPath}/executions`, { token }))[0].qa.state, 'queued');
  assert.equal((await request(taskPath, { token })).status, 'TESTING');
  await request(`${runPath}/review`, { ...review, status: 409 });

  assert.equal(await qa.runNext(), true);
  assert.equal((await request(`${taskPath}/executions`, { token }))[0].qa.state, 'failed');
  assert.equal((await request(overviewPath, { token })).alerts[0].kind, 'qa');
  await request(`${runPath}/qa/retry`, { token: viewerToken, method: 'POST', status: 403 });
  await request(`${runPath}/qa/retry`, { token, method: 'POST', status: 503 });
  await qa.retry(account, first.id, queued.taskId, run.id);
  assert.equal(await qa.runNext(), true);
  assert.equal(await qa.runNext(), false);
  assert.equal(qaCalls[1].agent.model, 'fixture-qa');
  assert.equal(qaCalls[1].agent.version, 2);
  assert.deepEqual(qaCalls[1].input.task.acceptanceCriteria, outputs.PRODUCT_MANAGER.acceptanceCriteria);
  assert.equal(qaCalls[1].input.verification.patchHash, patchHash);
  assert.equal(qaCalls[1].input.verification.checks[0].name, 'unit');
  assert.deepEqual(qaCalls[1].input.approvedRequirement, approvedContent);
  assert.equal(qaCalls[1].input.patch, patch.subarray(0, 64 * 1024).toString('utf8'));
  const [qaRun] = await request(`${taskPath}/executions`, { token });
  assert.equal(qaRun.qa.state, 'completed');
  assert.equal(qaRun.qa.patchHash, patchHash);
  assert.equal(qaRun.qa.partialPatch, true);
  assert.equal(qaRun.qa.assessment.recommendation, 'insufficient_evidence');
  assert.equal((await request(taskPath, { token })).status, 'REVIEW');
  const reviewedPage = await globalThis.fetch(new URL(`/?project=${first.id}&task=${queued.taskId}`, web), {
    headers: { Cookie: `ado_session=${token}` }, signal: globalThis.AbortSignal.timeout(30_000),
  });
  const reviewHtml = await reviewedPage.text();
  assert(reviewHtml.includes('证据不足') && reviewHtml.includes('批准变更') && reviewHtml.includes('截至本轮'));
  assert.equal((await request(`${runPath}/review`, review)).decision, 'approved');

  const operationsPath = `${prefix}/operations`;
  const operations = await request(operationsPath, { token });
  const pmUsage = operations.usage.find(({ role }) => role === 'PRODUCT_MANAGER');
  assert.deepEqual(pmUsage, { role: 'PRODUCT_MANAGER', model: 'fixture-pm-resolved',
    inputTokens: '40', cachedInputTokens: '10', outputTokens: '16' });
  assert.equal(operations.usage.find(({ role }) => role === 'QA_ENGINEER').model, 'fixture-qa-resolved');
  assert.equal(operations.usage.find(({ role }) => role === 'FRONTEND_DEVELOPER').inputTokens, '10');
  for (const action of ['requirement.approved', 'requirement.retired', 'task.approved', 'agent.step_completed', 'task.status_changed',
    'agent.qa_completed', 'execution.reviewed']) {
    assert(operations.audit.some((entry) => entry.action === action), `Missing ${action} in the project audit`);
  }
  assert.equal((await request(operationsPath, { token: viewerToken })).audit, null);
  assert.deepEqual((await request(`/projects/${second.id}/operations`, { token })).usage, []);
  await request(`/projects/${second.id}/operations`, { token: viewerToken, status: 404 });
  const otherOverview = `/projects/${second.id}/operations/overview`;
  await request(otherOverview, { token: viewerToken, status: 404 });
  assert.deepEqual((await request(otherOverview, { token })).executions, { queued: 0, running: 0, succeeded: 0, total: 0 });
  assert.equal((await request(overviewPath, { token })).executions.succeeded, 1);
  const metricsPage = await globalThis.fetch(new URL(`/?project=${first.id}&section=operations`, web), {
    headers: { Cookie: `ado_session=${token}` }, signal: globalThis.AbortSignal.timeout(30_000),
  });
  assert.equal(metricsPage.status, 200);
  const metricsHtml = await metricsPage.text();
  assert(metricsHtml.includes('fixture-pm-resolved') && metricsHtml.includes('最近审计记录') && metricsHtml.includes('执行队列'));

  const cancelled = await planning.start(account, first.id, { ...input, requirementId: null, request: 'Cancel during inference' });
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

  process.stdout.write('Approved requirement snapshots, Agent planning, Worker handoff, patch-bound QA, project usage and audit verified.\n');
} finally {
  await db.onModuleDestroy();
}
