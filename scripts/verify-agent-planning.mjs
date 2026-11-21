import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import process from 'node:process';
import { mock } from 'node:test';
import { URL } from 'node:url';
import { inspect } from 'node:util';
import { planningFailureMessages } from '@ado/shared';
import { Logger } from '@nestjs/common';
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
import { openAIPlanningModel, PlanningFailure } from '../apps/api/src/planning-model.ts';
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
const registry = new AgentRegistryService(db, projects);
const tasks = new TasksService(db, projects, registry);
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
    if (qaCalls.length === 1) throw new PlanningFailure('credentials_or_permissions', 403);
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
  const operationsPath = `${prefix}/operations`;
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
  assert((await request(operationsPath, { token })).audit.some(({ action, resourceId }) =>
    action === 'requirement.approved' && resourceId === requirement.id));
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
  assert.equal(skillV2.status, 'pending_evaluation');
  const evaluation = { token, method: 'PUT', body: { result: 'passed', evidence: 'Fixture accessibility checks passed' } };
  const approval = { token, method: 'PUT', body: { decision: 'approved' } };
  const v1Path = `${registryPath}/skills/${skill.id}/versions/1`;
  const v2Path = `${registryPath}/skills/${skill.id}/versions/2`;
  await request(`${v2Path}/decision`, { ...approval, status: 409 });
  await request(`${v2Path}/evaluation`, { ...evaluation, token: viewerToken, status: 403 });
  await request(`${v2Path}/decision`, { ...approval, token: viewerToken, status: 403 });
  await request(`/projects/${second.id}/agent-registry/skills/${skill.id}/versions/2/decision`, { ...approval, status: 404 });
  const failedEvaluation = await request(`${v1Path}/evaluation`, { ...evaluation,
    body: { result: 'failed', evidence: 'Fixture accessibility check failed' } });
  assert.equal(failedEvaluation.status, 'evaluation_failed');
  await request(`${v1Path}/decision`, { ...approval, status: 409 });
  assert.equal((await request(`${v1Path}/decision`, { ...approval, body: { decision: 'rejected' } })).status, 'rejected');
  const reference = { id: skill.id, version: skillV2.version };
  const config = { instructions: 'Cover empty states', model: 'fixture-codex', skills: [reference] };
  await request(`/projects/${second.id}/agent-registry/agents/FRONTEND_DEVELOPER/versions`, {
    token, method: 'POST', status: 404, body: config,
  });
  await request(`${developerPath}/versions`, { token, method: 'POST', status: 409, body: config });
  const [evaluated, evaluationRetry] = await Promise.all([
    request(`${v2Path}/evaluation`, evaluation), request(`${v2Path}/evaluation`, evaluation),
  ]);
  assert.equal(evaluated.status, 'awaiting_approval');
  assert.deepEqual(evaluationRetry, evaluated);
  await request(`${developerPath}/versions`, { token, method: 'POST', status: 409, body: config });
  const [approvedSkill, approvalRetry] = await Promise.all([
    request(`${v2Path}/decision`, approval), request(`${v2Path}/decision`, approval),
  ]);
  assert.equal(approvedSkill.status, 'approved');
  assert.deepEqual(approvalRetry, approvedSkill);
  assert.equal(approvedSkill.evaluation.evidence, evaluation.body.evidence);
  const approvalAudit = (await request(operationsPath, { token })).audit
    .filter(({ action, resourceId }) => action === 'skill.version_approved' && resourceId === skill.id);
  assert.equal(approvalAudit.length, 1);
  assert.deepEqual(approvalAudit[0].details, { version: 2 });
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
  assert((await request(operationsPath, { token })).audit.some(({ action, resourceId }) =>
    action === 'requirement.retired' && resourceId === requirement.id));
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

  await request(`${taskPath}/transition`, {
    token, method: 'POST', status: 409, body: { status: 'READY', developerRole: 'BACKEND_DEVELOPER' },
  });
  const planApproval = await request(`${taskPath}/transition`, { token, method: 'POST', body: { status: 'READY' } });
  assert.deepEqual(planApproval.developer, { role: 'FRONTEND_DEVELOPER', version: 2, model: config.model });
  await request(`${prefix}/repositories/${repo.id}/checks`, {
    token, method: 'PATCH', body: { checks: [{ name: 'unit', kind: 'unit', argv: ['node', '--test'] }],
      independentChecks: [{ name: 'browser', kind: 'browser' }] },
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
  assert.deepEqual(offer.development.agent.skills, [{ name: skill.name, version: skillV2.version, instructions: skillV2.instructions }]);
  assert.deepEqual(offer.development.requirement, approvedContent);
  assert.equal(offer.archivePatch, true);
  assert.equal(offer.development.qa, undefined);

  const runPath = `${taskPath}/executions/${run.id}`;
  const review = { token, method: 'POST', body: { decision: 'approved' } };
  const send = (sequence, kind, payload) => executions.record(worker, { runId: run.id, sequence, kind, payload });
  const patch = Buffer.from('diff --git a/settings.ts b/settings.ts\n--- a/settings.ts\n+++ b/settings.ts\n@@ -0,0 +1,3501 @@\n'
    + '+// Fixture settings patch\n'.repeat(3500) + '+export const savedValue = true;\n');
  const patchHash = createHash('sha256').update(patch).digest('hex');
  const baseCommit = 'a'.repeat(40);
  const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 };
  assert.equal((await send(1, 'thread', { threadId: 'fixture-qa-thread' })).accepted, true);
  assert.equal((await send(2, 'result', { attempt: 1, baseCommit, patchHash, files: ['settings.ts'], usage })).accepted, true);
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
  assert.equal((await request(taskPath, { token })).status, 'TESTING');
  const failureEvents = await request(`${taskPath}/events`, { token });
  const qaFailure = failureEvents.find(({ eventType }) => eventType === 'agent.qa_failed');
  assert.deepEqual(qaFailure?.payload, { runId: run.id, patchHash, error: 'credentials_or_permissions', httpStatus: 403 });
  assert.equal((await request(overviewPath, { token })).alerts[0].kind, 'qa');
  await request(`${runPath}/qa/retry`, { token: viewerToken, method: 'POST', status: 403 });
  await request(`${runPath}/qa/retry`, { token, method: 'POST', status: 503 });
  await qa.retry(account, first.id, queued.taskId, run.id);
  assert.equal(await qa.runNext(), true);
  assert.equal(await qa.runNext(), false);
  assert.equal(qaCalls[1].agent.model, 'fixture-qa');
  assert.equal(qaCalls[1].agent.version, 2);
  assert.deepEqual(qaCalls[1].input.task.acceptanceCriteria, outputs.PRODUCT_MANAGER.acceptanceCriteria);
  assert.equal(qaCalls[1].input.baseCommit, baseCommit);
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
  await request(`${runPath}/review`, { ...review, status: 409 });
  await request(`${runPath}/evidence`, { token, method: 'POST', status: 201,
    body: { patchHash, summary: 'Independent browser evidence for the full archive',
      check: { name: 'browser', status: 'passed', source: 'archive', environment: 'Synthetic browser' } },
  });
  assert.equal((await request(`${runPath}/review`, review)).decision, 'approved');

  const operations = await request(operationsPath, { token });
  const pmUsage = operations.usage.find(({ role }) => role === 'PRODUCT_MANAGER');
  assert.deepEqual(pmUsage, { role: 'PRODUCT_MANAGER', model: 'fixture-pm-resolved',
    inputTokens: '40', cachedInputTokens: '10', outputTokens: '16', estimatedUsd: null });
  assert.equal(operations.usage.find(({ role }) => role === 'QA_ENGINEER').model, 'fixture-qa-resolved');
  assert.equal(operations.usage.find(({ role }) => role === 'FRONTEND_DEVELOPER').inputTokens, '10');
  for (const action of ['task.approved', 'agent.step_completed', 'task.status_changed',
    'agent.qa_completed', 'execution.reviewed']) {
    assert(operations.audit.some((entry) => entry.action === action), `Missing ${action} in the project audit`);
  }
  assert.equal((await request(operationsPath, { token: viewerToken })).audit, null);
  const ratePath = `${operationsPath}/rates/fixture-pm-resolved`;
  const rate = { inputUsdPerMillion: '2', cachedInputUsdPerMillion: '0.4', outputUsdPerMillion: '10' };
  await request(ratePath, { token: viewerToken, method: 'PUT', body: rate, status: 403 });
  await request(ratePath, { token, method: 'PUT', body: { ...rate, outputUsdPerMillion: '-1' }, status: 400 });
  const savedRate = await request(ratePath, { token, method: 'PUT', body: rate });
  assert.equal(savedRate.cachedInputUsdPerMillion, '0.400000');
  await request(`/projects/${second.id}/operations/rates/fixture-pm-resolved`, {
    token, method: 'PUT', body: { ...rate, outputUsdPerMillion: '50' },
  });
  const estimates = await request(operationsPath, { token });
  assert.equal(estimates.usage.find(({ role }) => role === 'PRODUCT_MANAGER').estimatedUsd, '0.000224000000');
  assert.equal(estimates.usage.find(({ role }) => role === 'QA_ENGINEER').estimatedUsd, null);
  assert.equal(estimates.rates.length, 1);
  assert(estimates.audit.some(({ action }) => action === 'operations.model_rate_updated'));
  assert.equal((await request(operationsPath, { token: viewerToken })).rates, null);
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
  assert(metricsHtml.includes('估算费用 US$0.000224'));

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

  const providerPlanning = new AgentPlanningService(db, projects, tasks, registry, openAIPlanningModel);
  const credentialsMarker = 'fixture-provider-key-sensitive';
  const providerBodyMarker = 'fixture-provider-error-body-sensitive';
  const rawRequestMarker = 'fixture-provider-raw-request-sensitive';
  const promptMarker = 'fixture-provider-prompt-sensitive';
  const markers = [credentialsMarker, providerBodyMarker, rawRequestMarker, promptMarker];
  const providerRequest = 'Exercise planning diagnostics';
  const originalFetch = globalThis.fetch;
  const logMethods = ['error', 'warn', 'log', 'debug', 'verbose', 'fatal'].map((method) => mock.method(Logger.prototype, method));
  process.env.ADO_AGENT_API_KEY = credentialsMarker;
  process.env.ADO_AGENT_MODEL = 'fixture-model';
  const assertSafe = (value) => {
    const serialized = JSON.stringify(value);
    for (const marker of markers) assert(!serialized.includes(marker));
  };
  const showTask = async (taskId, sessionToken = token) => {
    const page = await globalThis.fetch(new URL(`/?project=${first.id}&task=${taskId}`, web), {
      headers: { Cookie: `ado_session=${sessionToken}` }, signal: globalThis.AbortSignal.timeout(30_000),
    });
    assert.equal(page.status, 200);
    return page.text();
  };
  try {
    const cases = [
      ['timeout', 'network'], [401, 'credentials_or_permissions'], [403, 'credentials_or_permissions'],
      [404, 'model_unavailable'], [429, 'rate_limited'], [503, 'server_error'], [418, 'unknown'],
      ['schema', 'invalid_structured_output'], ['json', 'invalid_structured_output'],
    ];
    for (const [failure, category] of cases) {
      let calls = 0;
      globalThis.fetch = async (url, options) => {
        if (String(url) !== 'https://api.openai.com/v1/responses') return originalFetch(url, options);
        calls++;
        assert.equal(options.headers.Authorization, `Bearer ${credentialsMarker}`);
        const body = JSON.parse(options.body);
        assert.equal(body.store, false);
        assert(body.instructions.includes(promptMarker));
        assert(JSON.parse(body.input).request.includes(rawRequestMarker));
        const echoed = [providerBodyMarker, options.headers.Authorization, body.input, body.instructions].join(' ');
        if (failure === 'timeout') throw new globalThis.DOMException(echoed, 'TimeoutError');
        if (failure === 'json' || failure === 'schema') {
          const text = failure === 'json' ? echoed : JSON.stringify({ objective: echoed, constraints: null });
          return globalThis.Response.json({
            status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
          });
        }
        return globalThis.Response.json({ error: { message: echoed, code: 'model_not_found' } }, { status: failure });
      };
      const diagnostic = await providerPlanning.start(account, first.id, { repositoryId: repo.id, request: providerRequest });
      // Markers in the invocation context must remain in the preexisting private fields.
      await db.pool.query(
        `UPDATE task_agent_plans
         SET input = jsonb_set(input, '{request}', to_jsonb($2::text)),
             assignments = jsonb_set(assignments, '{PROJECT_DIRECTOR,instructions}', to_jsonb($3::text))
         WHERE task_id = $1`, [diagnostic.taskId, rawRequestMarker, promptMarker],
      );
      assert.equal(await providerPlanning.runNext(), true);
      assert.equal(await providerPlanning.runNext(), false, 'Failed plans require an explicit retry');
      assert.equal(calls, 1);
      const detailPath = `${prefix}/tasks/${diagnostic.taskId}`;
      const diagnosisPath = `${detailPath}/agent-plan`;
      const { plan: detail } = await request(diagnosisPath, { token });
      assert.deepEqual(detail, {
        taskId: diagnostic.taskId, state: 'failed', stage: 'PROJECT_DIRECTOR', steps: [],
        error: 'planning_step_failed', failureCategory: category,
      });
      assert.equal((await request(detailPath, { token })).status, 'PLANNING');
      const { rows: [saved] } = await db.pool.query(
        'SELECT error, failure_category, steps, lease_id, lease_expires_at FROM task_agent_plans WHERE task_id = $1',
        [diagnostic.taskId],
      );
      assert.deepEqual(saved, {
        error: 'planning_step_failed', failure_category: category, steps: [], lease_id: null, lease_expires_at: null,
      });
      const events = await request(`${detailPath}/events`, { token });
      assert.deepEqual(events.map(({ eventType }) => eventType), ['task.created', 'agent.plan_queued', 'agent.plan_failed']);
      assert.deepEqual(events.at(-1).payload, { role: 'PROJECT_DIRECTOR', error: 'planning_step_failed' });
      const { audit } = await request(operationsPath, { token });
      assert(audit.some(({ action, resourceId }) => action === 'agent.plan_failed' && resourceId === diagnostic.taskId));
      const page = await showTask(diagnostic.taskId);
      const { label, hint } = planningFailureMessages[category];
      assert(page.includes(label) && page.includes(hint));
      assertSafe({ saved, detail, events, audit, page });

      if (failure === 403) {
        const { plan: viewerPlan } = await request(diagnosisPath, { token: viewerToken });
        assert.equal(viewerPlan.state, 'failed');
        assert.equal(viewerPlan.failureCategory, undefined);
        assert(!(await showTask(diagnostic.taskId, viewerToken)).includes(hint));
        await request(`/projects/${second.id}/tasks/${diagnostic.taskId}/agent-plan`, { token: viewerToken, status: 404 });
        for (const legacy of [null, 'fixture-unrecognized-category']) {
          await db.pool.query('UPDATE task_agent_plans SET failure_category = $2 WHERE task_id = $1',
            [diagnostic.taskId, legacy]);
          assert.equal((await request(diagnosisPath, { token })).plan.failureCategory, undefined);
          const legacyPage = await showTask(diagnostic.taskId);
          assert(legacyPage.includes(planningFailureMessages.unknown.hint));
          assert(!legacyPage.includes('fixture-unrecognized-category'));
        }
      }
      if (failure === 429) {
        await request(`${diagnosisPath}/retry`, { token: viewerToken, method: 'POST', status: 403 });
        const retry = await providerPlanning.retry(account, first.id, diagnostic.taskId);
        assert.equal(retry.state, 'queued');
        assert.equal(retry.error, null);
        assert.equal(retry.failureCategory, undefined);
        const { rows: [retried] } = await db.pool.query('SELECT failure_category FROM task_agent_plans WHERE task_id = $1',
          [diagnostic.taskId]);
        assert.equal(retried.failure_category, null);
        assert.equal(await providerPlanning.runNext(), true);
        assert.equal(calls, 2);
        assert.equal((await request(diagnosisPath, { token })).plan.failureCategory, category);
        const retryEvents = await request(`${detailPath}/events`, { token });
        assert.deepEqual(retryEvents.slice(-2).map(({ eventType }) => eventType), ['agent.plan_retried', 'agent.plan_failed']);
        assertSafe(retryEvents);
      }
    }
    assertSafe(inspect(logMethods.flatMap(({ mock: loggerMock }) => loggerMock.calls.map(({ arguments: args }) => args)),
      { depth: null, maxArrayLength: null, maxStringLength: null }));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ADO_AGENT_API_KEY;
    delete process.env.ADO_AGENT_MODEL;
    mock.restoreAll();
  }

  process.stdout.write('Approved requirements, Agent handoff, QA, project usage, rate estimates, audit and planning diagnostics verified.\n');
} finally {
  await db.onModuleDestroy();
}
