import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import process from 'node:process';
import { mock } from 'node:test';
import { URL } from 'node:url';
import { inspect } from 'node:util';
import { parseDecisionReply, planningFailureMessages } from '@ado/shared';
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
let sourceCommit = 'a'.repeat(40);
let sourceAvailable = true;
class FixtureGitHub extends GitHubApp {
  async planningSource() {
    return { commit: sourceCommit };
  }

  async planningEvidence(source, request) {
    assert.equal(source.repository, 'test/planning-fixture');
    return { commit: sourceCommit, incompleteTree: false,
      files: !sourceAvailable && request === 'Check missing evidence' ? [] : [
        { path: 'src/settings.ts', excerpt: 'Settings are visible to the project owner.', truncated: false },
        { path: 'docs/settings.md', excerpt: 'Keep an empty state when settings are unavailable.', truncated: false },
      ] };
  }
}
const github = new FixtureGitHub();
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
const architectureReview = {
  findings: ['Re-use the existing settings service'], evidence: ['src/settings.ts'], blockers: [],
  assumptions: ['Confirm older browser support in the smoke test'], decisions: [],
};
const outputs = {
  PROJECT_DIRECTOR: { objective: 'Create a settings page', constraints: ['Use the existing repository'] },
  PRODUCT_MANAGER: {
    title: 'Settings page', userStory: 'As a user I can view settings', requirements: ['Show the saved value'],
    acceptanceCriteria: ['The page displays the saved value'], needsDesign: false, affectedReviewers: [],
  },
  ARCHITECT: {
    developer: 'FRONTEND_DEVELOPER', steps: ['Add the route and wire the existing data source'],
    risks: ['Missing data state'], testApproach: ['Exercise the page with and without saved data'], review: architectureReview,
  },
  UI_UX_DESIGNER: { design: ['Show the existing empty state'], review: { ...architectureReview, evidence: ['docs/settings.md'] } },
};
const plannedDecision = { question: 'Who may disable an account?', options: ['Project owners only', 'All project members'] };
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
    const policy = input.request === 'Confirm account policy';
    const board = input.request === '给任务看板列表增加优先级和状态显示';
    if (board && role === 'PROJECT_DIRECTOR') {
      return modelReply(agent, { ...outputs.PROJECT_DIRECTOR, decisions: input.phase === 'coordinate' ? [] : [
        { question: '任务是否已有优先级和状态字段？', options: ['复用字段', '新增字段'],
          impact: '决定是否需要调整接口', reviewers: ['ARCHITECT'] },
      ] });
    }
    if (role === 'PROJECT_DIRECTOR' && policy) {
      const review = { ...plannedDecision, impact: 'Changes the account action and its access policy', reviewers: ['ARCHITECT'] };
      return modelReply(agent, { ...outputs.PROJECT_DIRECTOR, decisions: input.phase === 'coordinate'
        ? [review, { ...review, question: `${review.question} 此决定尚未作出。`, reviewers: ['UI_UX_DESIGNER'] }]
        : [review] });
    }
    const answers = input.humanDecisions?.flatMap(({ answer }) => answer ? [answer] : []) ?? [];
    if (role === 'PRODUCT_MANAGER') {
      const design = input.request === 'Add a settings page' || policy || board;
      return modelReply(agent, { ...outputs.PRODUCT_MANAGER, needsDesign: design,
        ...(answers.length && { requirements: answers, acceptanceCriteria: answers.map((answer) => `Verify: ${answer}`) }),
      });
    }
    if (role === 'ARCHITECT' && policy) {
      return modelReply(agent, { ...outputs.ARCHITECT,
        ...(answers.length && { steps: answers.map((answer) => `Implement: ${answer}`) }),
        review: { ...architectureReview, decisions: answers.length ? [] : [
          { ...plannedDecision, impact: 'Changes the account action and its access policy', reviewers: ['ARCHITECT', 'UI_UX_DESIGNER'] },
        ] },
      });
    }
    return modelReply(agent, outputs[role]);
  },
}, github);

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
    body: { email: `viewer-${suffix}@example.test`, name: 'Planning viewer', password, systemRole: 'user' } });
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

  const { rows: [repo] } = await db.projectQuery(first.id,
    `INSERT INTO repositories (project_id, github_repository_id, owner, repo_name, repository_url, default_branch, installation_id)
     VALUES ($1, $2, 'test', 'planning-fixture', 'https://github.com/test/planning-fixture', 'main', 1) RETURNING id`,
    [first.id, Number.parseInt(suffix, 16)],
  );
  const knowledgePath = `${prefix}/knowledge`;
  const otherKnowledgePath = `/projects/${second.id}/knowledge`;
  const draft = {
    kind: 'design_rule', title: 'Workbench loading and retry', excerpt: 'Keep task context when retrying.',
    sourceUrl: 'https://example.test/design/workbench', sourceRevision: 'first-design-2026',
    designEvidence: { repositoryId: repo.id, implementationCommit: 'a'.repeat(40), reportUrl: 'https://example.test/report/a' },
  };
  await request(knowledgePath, { token: viewerToken, method: 'POST', status: 403, body: draft });
  await request(otherKnowledgePath, { token, method: 'POST', status: 404, body: draft });
  const firstVersion = await request(knowledgePath, { token, method: 'POST', status: 201, body: draft });
  const entryPath = `${knowledgePath}/${firstVersion.entryId}`;
  const decide = (versionId, decision, session = token, status = 200) =>
    request(`${entryPath}/versions/${versionId}/decision`, { token: session, method: 'PUT', body: { decision }, status });
  const activate = (versionId, status = 200, expectedVersionId) =>
    request(`${entryPath}/active-version`, { token, method: 'PUT', body: { versionId, expectedVersionId }, status });
  assert.deepEqual(await request(knowledgePath, { token: viewerToken }), []);
  await request(entryPath, { token: viewerToken, status: 404 });
  await request(`${otherKnowledgePath}/${firstVersion.entryId}`, { token, status: 404 });
  await request(otherKnowledgePath, { token: viewerToken, status: 404 });
  await activate(firstVersion.id, 409);
  await decide(firstVersion.id, 'approved', viewerToken, 403);
  await Promise.all([decide(firstVersion.id, 'approved'), decide(firstVersion.id, 'approved')]);
  await decide(firstVersion.id, 'rejected', token, 409);
  assert.deepEqual(await request(knowledgePath, { token: viewerToken }), []);
  await activate(firstVersion.id);
  const [searchMatch] = await request(`${knowledgePath}?q=retrying&kind=design_rule`, { token: viewerToken });
  assert.equal(searchMatch.activeVersionId, firstVersion.id);
  const originalKnowledge = (await request(entryPath, { token: viewerToken })).versions[0];
  assert.equal(originalKnowledge.excerptHash, createHash('sha256').update(draft.excerpt).digest('hex'));
  assert.equal(originalKnowledge.designEvidence.implementationCommit, draft.designEvidence.implementationCommit);
  assert.equal(originalKnowledge.designEvidence.reportUrl, draft.designEvidence.reportUrl);
  const secondVersion = await request(`${entryPath}/versions`, { token, method: 'POST', status: 201,
    body: { ...draft, excerpt: 'Use the new retry treatment.', sourceRevision: 'second-design-2026' } });
  assert.equal(secondVersion.version, 2);
  await decide(secondVersion.id, 'approved');
  const foreignVersion = await request(otherKnowledgePath, { token, method: 'POST', status: 201,
    body: { ...draft, kind: 'project_document', excerpt: 'Only applicable to the other project.' } });
  await request(`${otherKnowledgePath}/${foreignVersion.entryId}/versions/${foreignVersion.id}/decision`, {
    token, method: 'PUT', body: { decision: 'approved' },
  });
  await request(`${otherKnowledgePath}/${foreignVersion.entryId}/active-version`, {
    token, method: 'PUT', body: { versionId: foreignVersion.id },
  });
  await assert.rejects(db.projectQuery(first.id, 'UPDATE project_knowledge SET active_version_id=$2 WHERE id=$1',
    [firstVersion.entryId, foreignVersion.id]), error => error.code === '23503');
  const input = { request: 'Add a settings page', repositoryId: repo.id, requirementId: requirement.id,
    knowledgeVersionIds: [firstVersion.id] };
  await request(`${prefix}/agent-plans`, { token, method: 'POST', status: 400,
    body: { ...input, knowledgeVersionIds: [firstVersion.id, firstVersion.id] } });
  for (const id of [secondVersion.id, foreignVersion.id]) {
    await request(`${prefix}/agent-plans`, { token, method: 'POST', status: 404,
      body: { ...input, knowledgeVersionIds: [id] } });
  }
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
  const [frozenKnowledge] = queued.knowledge;
  assert.equal(frozenKnowledge.id, firstVersion.id);
  assert.equal(frozenKnowledge.excerptHash, originalKnowledge.excerptHash);
  assert.equal(frozenKnowledge.sourceRevision, originalKnowledge.sourceRevision);
  assert.equal(frozenKnowledge.designEvidence, undefined);
  await activate(secondVersion.id);
  const [historicalMatch] = await request(`${knowledgePath}?q=retrying&history=1`, { token: viewerToken });
  assert.equal(historicalMatch.matchedVersionId, firstVersion.id);
  assert.equal(historicalMatch.activeVersionId, secondVersion.id);
  await activate(null, 409, firstVersion.id);
  await request(`${prefix}/agent-plans`, { token, method: 'POST', status: 404, body: input });
  assert.equal((await request(knowledgePath, { token }))[0].activeVersionId, secondVersion.id);
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
  await db.projectQuery(first.id,
    `UPDATE task_agent_plans SET state = 'running', lease_id = gen_random_uuid(),
      lease_expires_at = now() - interval '1 second' WHERE task_id = $1`, [queued.taskId],
  );
  for (let index = 0; index < 4; index++) assert.equal(await planning.runNext(), true);
  assert.equal(await planning.runNext(), false);
  const { plan: complete } = await request(planPath, { token });
  assert.equal(complete.state, 'completed');
  assert.equal(complete.stage, null);
  assert.deepEqual(complete.requirement, requirement);
  assert.deepEqual(complete.knowledge, [frozenKnowledge]);
  assert(modelCalls.every(({ input: modelInput }) => JSON.stringify(modelInput.approvedRequirement) === JSON.stringify(approvedContent)));
  for (const { input: modelInput } of modelCalls) assert.deepEqual(modelInput.approvedKnowledge, [frozenKnowledge]);
  assert.equal((await request(planPath, { token })).plan.proposal?.commit, 'a'.repeat(40));
  assert.deepEqual(complete.proposal.design.design, ['Show the existing empty state']);
  assert.deepEqual(complete.proposal.design.review.evidence, ['docs/settings.md']);
  assert.deepEqual(complete.proposal.architecture.review.evidence, ['src/settings.ts']);
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
  assert(html.includes('用 Agent 规划需求') && html.includes('批准方案') && html.includes('实施步骤'));
  const registryPage = await globalThis.fetch(new URL(`/?project=${first.id}&section=agents`, web), {
    headers: { Cookie: `ado_session=${token}` },
  });
  assert.equal(registryPage.status, 200);
  assert((await registryPage.text()).includes('Agent 与 Skill'));
  assert(html.includes(requirement.referenceUrl) && html.includes('规划使用的批准摘录'));

  await request(`${taskPath}/transition`, {
    token, method: 'POST', status: 409, body: { status: 'READY', developerRole: 'BACKEND_DEVELOPER', planVersion: complete.proposal.version },
  });
  await request(`${taskPath}/transition`, { token, method: 'POST', body: { status: 'READY' }, status: 409 });
  const repositoryChecks = {
    checks: [{ name: 'unit', kind: 'unit', argv: ['node', '--test'] }],
    independentChecks: [{ name: 'browser', kind: 'browser' }],
  };
  const updateChecks = (body = repositoryChecks) => request(`${prefix}/repositories/${repo.id}/checks`, { token, method: 'PATCH', body });
  await updateChecks();
  const planApproval = await request(`${taskPath}/transition`, {
    token, method: 'POST', body: { status: 'READY', planVersion: complete.proposal.version },
  });
  assert.deepEqual(await request(`${taskPath}/executions`, { token }), [], 'Approval does not dispatch');
  assert.equal((await request(planPath, { token })).plan.approvedVersion, complete.proposal.version);
  assert.deepEqual(planApproval.developer, { role: 'FRONTEND_DEVELOPER', version: 2, model: config.model });
  await updateChecks({ ...repositoryChecks, independentChecks: [] });
  await assert.rejects(executions.queue(account, first.id, queued.taskId), /verification settings changed/);
  await updateChecks();
  sourceCommit = 'b'.repeat(40);
  await assert.rejects(executions.queue(account, first.id, queued.taskId), /approved commit/);
  sourceCommit = 'a'.repeat(40);
  const credential = await request(`${prefix}/workers`, {
    token, method: 'POST', status: 201, body: { name: 'Planning handoff fixture' },
  });
  const { rows: [worker] } = await db.pool.query(
    `UPDATE workers SET connection_id = gen_random_uuid(), capabilities = '{"codexVersion":"0.170.0","verificationVersion":1}'
     WHERE id = $1 RETURNING id AS "workerId", credential_hash AS hash, connection_id AS "connectionId"`, [credential.workerId],
  );
  await assert.rejects(executions.queue(account, first.id, queued.taskId), /updated Worker is required/);
  await db.pool.query("UPDATE workers SET capabilities = capabilities || '{\"artifactVersion\":1,\"approvedPlanVersion\":1}' WHERE id = $1", [worker.workerId]);
  const run = await executions.queue(account, first.id, queued.taskId);
  assert.equal(run.requestedWorkerId, worker.workerId);
  const offer = await executions.claim(worker);
  assert.equal(offer?.id, run.id);
  assert.deepEqual(offer.development.approvedPlan, complete.proposal);
  assert.equal(offer.development.agent.version, 2);
  assert.equal(offer.development.agent.model, config.model);
  assert.deepEqual(offer.development.agent.skills, [{ name: skill.name, version: skillV2.version, instructions: skillV2.instructions }]);
  assert.deepEqual(offer.development.requirement, approvedContent);
  assert.deepEqual(offer.development.knowledge, [frozenKnowledge]);
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
  assert.equal((await send(2, 'result', { attempt: 1, baseCommit: 'b'.repeat(40), patchHash, files: ['settings.ts'], usage })).accepted, false);
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
  for (const { input: reviewInput } of qaCalls) assert.deepEqual(reviewInput.approvedKnowledge, [frozenKnowledge]);
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
  const archivedRule = await request(`${entryPath}/versions`, { token, method: 'POST', status: 201, body: {
    ...draft, designEvidence: { ...draft.designEvidence, runId: run.id },
  } });
  const library = await request(entryPath, { token });
  assert.deepEqual(library.versions.find(item => item.id === archivedRule.id).designEvidence.archive,
    { runId: run.id, taskId: queued.taskId, patchHash });
  const rulePage = await globalThis.fetch(new URL(
    `/?project=${first.id}&section=knowledge&knowledgeEntry=${firstVersion.entryId}&knowledgeVersion=${archivedRule.id}`, web),
  { headers: { Cookie: `ado_session=${token}` }, signal: globalThis.AbortSignal.timeout(30_000) });
  assert.equal(rulePage.status, 200);
  const ruleHtml = await rulePage.text();
  assert(ruleHtml.includes(draft.designEvidence.reportUrl) && ruleHtml.includes('查看实现提交')
    && ruleHtml.includes(`/artifacts/${first.id}/${queued.taskId}/${run.id}`));
  await request(`${entryPath}/versions`, { token, method: 'POST', status: 404, body: {
    ...draft, designEvidence: { ...draft.designEvidence, runId: foreignVersion.id },
  } });
  await activate(firstVersion.id);
  assert.equal((await request(knowledgePath, { token }))[0].activeVersionId, firstVersion.id);
  await activate(null, 200, firstVersion.id);
  assert.deepEqual(await request(knowledgePath, { token: viewerToken }), []);
  assert.equal((await request(`${knowledgePath}?history=1`, { token: viewerToken }))[0].id, firstVersion.entryId);
  assert.equal((await request(entryPath, { token: viewerToken })).versions.length, 2);
  await activate(secondVersion.id);

  const operations = await request(operationsPath, { token });
  const pmUsage = operations.usage.find(({ role }) => role === 'PRODUCT_MANAGER');
  assert.deepEqual(pmUsage, { role: 'PRODUCT_MANAGER', model: 'fixture-pm-resolved',
    inputTokens: '60', cachedInputTokens: '15', outputTokens: '24', estimatedUsd: null });
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
  assert.equal(estimates.usage.find(({ role }) => role === 'PRODUCT_MANAGER').estimatedUsd, '0.000336000000');
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
  assert(metricsHtml.includes('fixture-pm-resolved') && metricsHtml.includes('最近审计记录') && metricsHtml.includes('累计 TOKENS'));
  assert(metricsHtml.includes('月度费用与预算') && metricsHtml.includes('暂无估算'));

  const cancelled = await planning.start(account, first.id, { ...input, requirementId: null, request: 'Cancel during inference',
    knowledgeVersionIds: [secondVersion.id] });
  assert.equal(cancelled.knowledge[0].id, secondVersion.id);
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
  assert.equal(plan.knowledge[0].id, secondVersion.id);
  assert.equal((await request(cancelledPath, { token })).status, 'CANCELLED');

  const { taskId: decisionTaskId } = await planning.start(account, first.id, { repositoryId: repo.id, request: 'Confirm account policy' });
  for (const role of ['PROJECT_DIRECTOR', 'PRODUCT_MANAGER', 'ARCHITECT']) {
    assert(await planning.runNext(), `Expected to run ${role}`);
  }
  const decisionPath = `${prefix}/tasks/${decisionTaskId}`;
  assert.deepEqual((await request(decisionPath, { token })).decisions, [],
    'Candidate questions stay in planning until the evidence reviews finish');
  assert.equal(await planning.runNext(), true, 'UI/UX reviews the same draft');
  assert.deepEqual((await request(decisionPath, { token })).decisions, []);
  assert.equal(await planning.runNext(), true, 'The Director reconciles evidence-backed decisions');
  let approvalVersion;
  const approve = (status = 200) => request(`${decisionPath}/transition`, {
    token, method: 'POST', body: { status: 'READY', planVersion: approvalVersion }, status,
  });
  await approve(409);
  const { decisions: [planned] } = await request(decisionPath, { token });
  assert.equal(planned.question, plannedDecision.question);
  assert.equal(planned.impact, 'Changes the account action and its access policy');
  assert.deepEqual(planned.options, plannedDecision.options);
  assert.deepEqual(planned.reviewers, ['ARCHITECT', 'UI_UX_DESIGNER']);
  assert.equal((await request(decisionPath, { token })).decisions.length, 1);
  assert.equal((await request(`${decisionPath}/agent-plan`, { token })).plan.reviewStatus, 'waiting_decisions');
  const submit = (answers, status = 204, session = token) => request(`${decisionPath}/decisions`, {
    token: session, method: 'POST', body: { answers }, status,
  });
  await submit([{ id: planned.id, answer: planned.options[0] }], 403, viewerToken);
  await submit([{ id: 'unknown', answer: planned.options[0] }], 409);
  assert.equal(await planning.runNext(), false);
  const waiting = (await request(`${decisionPath}/agent-plan`, { token })).plan;
  assert(waiting.steps.some(({ role }) => role === 'UI_UX_DESIGNER'));
  assert.equal(waiting.proposal, undefined);
  await request(`${decisionPath}/executions`, { token, method: 'POST', status: 409 });
  const dispatchUrl = new URL(`/?project=${first.id}&section=tasks&task=${decisionTaskId}&dialog=dispatch`, web);
  const dispatchPage = await globalThis.fetch(dispatchUrl, {
    headers: { Cookie: `ado_session=${token}` }, signal: globalThis.AbortSignal.timeout(30_000),
  });
  assert.equal(dispatchPage.status, 200);
  const dispatchHtml = await dispatchPage.text();
  assert(dispatchHtml.includes(planned.question) && !dispatchHtml.includes('确认派发任务'));
  await submit([{ id: planned.id, answer: planned.options[0] }]);
  await approve(409);
  assert.equal(await planning.runNext(), true, 'The product manager revises the shared draft');
  await approve(409);
  for (let index = 0; index < 2; index++) assert.equal(await planning.runNext(), true);
  const initialProposal = (await request(`${decisionPath}/agent-plan`, { token })).plan.proposal;
  approvalVersion = initialProposal.version;
  assert.deepEqual(initialProposal.product.acceptanceCriteria, [`Verify: ${planned.options[0]}`]);
  assert.deepEqual(initialProposal.architecture.steps, [`Implement: ${planned.options[0]}`]);
  assert.deepEqual(await request(`${decisionPath}/executions`, { token }), []);
  await approve();

  const firstRun = await executions.queue(account, first.id, decisionTaskId);
  const firstOffer = await executions.claim(worker);
  assert.equal(firstOffer.id, firstRun.id);
  assert.equal(firstOffer.decisionReporting, true);
  assert.deepEqual(firstOffer.development.approvedPlan, initialProposal);
  const runtimeDecision = { question: 'How is the last administrator protected?', options: [
    'Reject disabling the last active administrator', 'Require another administrator to be assigned first',
  ] };
  const runtimeDecisions = parseDecisionReply(`ADO_DECISIONS\n${JSON.stringify([runtimeDecision])}`);
  assert.deepEqual(runtimeDecisions, [runtimeDecision]);
  assert.equal(parseDecisionReply('ADO_DECISIONS\n[{"question":"Missing choices","options":[]}]'), null);
  const reportedFailure = await executions.record(worker, { runId: firstRun.id, sequence: 1, kind: 'failed',
    payload: { code: 'needs_decisions', decisions: runtimeDecisions } });
  assert.equal(reportedFailure.accepted, true);
  const card = (await request(`${prefix}/tasks`, { token })).find(({ id }) => id === decisionTaskId);
  assert.deepEqual(card.executionFailure, { runId: firstRun.id, code: 'needs_decisions', decisions: [runtimeDecision] });
  await request(`${decisionPath}/executions`, { token, method: 'POST', status: 409 });
  const decisionPage = await globalThis.fetch(new URL(`/?project=${first.id}&section=tasks&task=${decisionTaskId}`, web), {
    headers: { Cookie: `ado_session=${token}` }, signal: globalThis.AbortSignal.timeout(30_000),
  });
  assert.equal(decisionPage.status, 200);
  const decisionHtml = await decisionPage.text();
  assert(decisionHtml.replaceAll('<!-- -->', '').includes('1 项待人工确认') && decisionHtml.includes('提交决定'));
  assert(decisionHtml.includes(runtimeDecision.question) && decisionHtml.includes(runtimeDecision.options[0]));

  const pending = card.decisions.find(({ answer }) => !answer);
  const runtimeAnswer = { id: pending.id, answer: runtimeDecision.options[0] };
  const decisionForm = [...decisionHtml.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gu)]
    .find(([form]) => form.includes(`name="decision:${pending.id}"`));
  const submitAction = decisionForm?.[0].match(/name="(\$ACTION_ID_[^"]+)"/u)?.[1];
  assert(submitAction, 'The decision form has a server action');
  const formData = new globalThis.FormData();
  formData.set(submitAction, '');
  formData.set('projectId', first.id);
  formData.set('taskId', decisionTaskId);
  formData.set(`decision:${pending.id}`, runtimeAnswer.answer);
  const submittedPage = await globalThis.fetch(decisionPage.url, {
    method: 'POST', body: formData, headers: { Cookie: `ado_session=${token}`, Origin: web.origin },
    redirect: 'manual', signal: globalThis.AbortSignal.timeout(30_000),
  });
  assert.equal(submittedPage.status, 303);
  assert(submittedPage.headers.get('location')?.includes('notice=decisions-submitted'));
  await submit([runtimeAnswer], 409);
  assert.equal((await request(decisionPath, { token })).status, 'PLANNING');
  await request(`${decisionPath}/executions`, { token, method: 'POST', status: 409 });
  for (let index = 0; index < 3; index++) assert.equal(await planning.runNext(), true);
  await approve(409);
  const revisedProposal = (await request(`${decisionPath}/agent-plan`, { token })).plan.proposal;
  assert.notEqual(revisedProposal.version, initialProposal.version);
  approvalVersion = revisedProposal.version;
  await approve();
  const secondRun = await executions.queue(account, first.id, decisionTaskId);
  const secondOffer = await executions.claim(worker);
  assert.equal(secondOffer.id, secondRun.id);
  assert.deepEqual(secondOffer.development.approvedPlan, revisedProposal);
  assert(secondOffer.development.approvedPlan.architecture.steps.includes(`Implement: ${runtimeAnswer.answer}`));
  const decisionHistory = await request(`${decisionPath}/events`, { token });
  assert.equal(decisionHistory.filter(({ payload }) => payload.to === 'READY').length, 2);
  assert.equal(decisionHistory.filter(({ eventType }) => eventType === 'task.decisions_submitted').length, 2);
  const runsAfterDecision = await request(`${decisionPath}/executions`, { token });
  assert.deepEqual(runsAfterDecision.map(({ id, status }) => [id, status]), [[secondRun.id, 'running'], [firstRun.id, 'failed']]);
  assert.equal((await request(`${decisionPath}/executions/${firstRun.id}/events`, { token }))[0].payload.code, 'needs_decisions');
  await executions.record(worker, { runId: secondRun.id, sequence: 1, kind: 'failed', payload: { code: 'no_changes' } });

  sourceAvailable = false;
  const { taskId: evidenceTaskId } = await planning.start(account, first.id, { repositoryId: repo.id, request: 'Check missing evidence' });
  for (let index = 0; index < 3; index++) assert.equal(await planning.runNext(), true);
  const evidencePath = `${prefix}/tasks/${evidenceTaskId}`;
  const blocked = (await request(`${evidencePath}/agent-plan`, { token })).plan;
  assert.equal(blocked.reviewStatus, 'waiting_evidence');
  assert(blocked.blockers.length);
  await request(`${evidencePath}/transition`, { token, method: 'POST', body: { status: 'READY' }, status: 409 });
  await request(`${evidencePath}/executions`, { token, method: 'POST', status: 409 });
  sourceAvailable = true;
  await planning.retry(account, first.id, evidenceTaskId);
  for (let index = 0; index < 4; index++) assert.equal(await planning.runNext(), true);
  const backendProposal = (await request(`${evidencePath}/agent-plan`, { token })).plan.proposal;
  assert.equal(backendProposal.design, undefined);
  assert(backendProposal.architecture.review.assumptions.length);

  const board = await planning.start(account, first.id, {
    repositoryId: repo.id, request: '给任务看板列表增加优先级和状态显示',
  });
  const boardPath = `${prefix}/tasks/${board.taskId}`;
  for (let index = 0; index < 6; index++) {
    assert.equal(await planning.runNext(), true);
    assert.deepEqual((await request(boardPath, { token })).decisions, []);
  }
  const { plan: boardPlan } = await request(`${boardPath}/agent-plan`, { token });
  assert.equal(boardPlan.reviewStatus, 'ready', 'Evidence-resolved questions do not block approval');
  assert(boardPlan.proposal.architecture.review.evidence.length && boardPlan.proposal.design.review.evidence.length);

  const { taskId: legacyTaskId } = await planning.start(account, first.id, { repositoryId: repo.id, request: 'Legacy account scope' });
  await db.projectQuery(first.id, "UPDATE task_agent_plans SET input = input - 'workflow' WHERE task_id = $1", [legacyTaskId]);
  for (const role of ['PROJECT_DIRECTOR', 'PRODUCT_MANAGER', 'ARCHITECT']) {
    assert(await planning.runNext(), `Expected to run ${role}`);
  }
  const legacyPath = `${prefix}/tasks/${legacyTaskId}`;
  await request(`${legacyPath}/transition`, { token, method: 'POST', body: { status: 'READY' } });
  const legacyRun = await request(`${legacyPath}/executions`, { token, method: 'POST', status: 201 });
  assert.equal((await executions.claim(worker)).id, legacyRun.id);
  await executions.record(worker, { runId: legacyRun.id, sequence: 1, kind: 'failed', payload: { code: 'no_changes' } });
  await db.projectQuery(first.id,
    "UPDATE task_agent_plans SET steps = jsonb_set(steps, '{2,output,steps}', $2::jsonb) WHERE task_id = $1",
    [legacyTaskId, JSON.stringify(['提交人工审批：确认账号维护范围、权限粒度。删除暂不纳入。'])],
  );
  const legacy = await request(legacyPath, { token });
  assert.equal(legacy.executionFailure.code, 'no_changes');
  assert.deepEqual(legacy.decisions.map(({ question }) => question), ['账号维护范围', '权限粒度']);
  await request(`${legacyPath}/executions`, { token, method: 'POST', status: 409 });

  const providerPlanning = new AgentPlanningService(db, projects, tasks, registry, openAIPlanningModel, github);
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
      await db.projectQuery(first.id,
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
        error: 'planning_step_failed', failureCategory: category, reviewStatus: 'reviewing',
      });
      assert.equal((await request(detailPath, { token })).status, 'PLANNING');
      const { rows: [saved] } = await db.projectQuery(first.id,
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
          await db.projectQuery(first.id, 'UPDATE task_agent_plans SET failure_category = $2 WHERE task_id = $1',
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
        const { rows: [retried] } = await db.projectQuery(first.id, 'SELECT failure_category FROM task_agent_plans WHERE task_id = $1',
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

  await activate(firstVersion.id);
  const racingRequest = { ...input, requirementId: null, request: 'Concurrent knowledge activation' };
  const [intakeResult] = await Promise.allSettled([planning.start(account, first.id, racingRequest), activate(secondVersion.id)]);
  if (intakeResult.status === 'fulfilled') {
    assert.deepEqual(intakeResult.value.knowledge, [frozenKnowledge]);
    await request(`${prefix}/tasks/${intakeResult.value.taskId}/transition`, {
      token, method: 'POST', body: { status: 'CANCELLED' },
    });
  } else {
    assert.equal(intakeResult.reason.getStatus(), 404);
    const { rows: [{ count }] } = await db.projectQuery(first.id,
      'SELECT count(*)::int FROM tasks WHERE project_id=$1 AND title=$2', [first.id, racingRequest.request],
    );
    assert.equal(count, 0);
  }
  assert.equal((await request(knowledgePath, { token }))[0].activeVersionId, secondVersion.id);
  await assert.rejects(planning.start(account, first.id, racingRequest), error => error.getStatus() === 404);
  process.stdout.write('Approved requirements, Agent handoff, QA, project usage, rate estimates, audit and planning diagnostics verified.\n');
  process.stdout.write('Project knowledge search, version approval, project isolation, design evidence and frozen planning, Worker and QA inputs verified.\n');
  process.stdout.write('Execution decision recovery and approval history verified.\n');
} finally {
  await db.onModuleDestroy();
}
