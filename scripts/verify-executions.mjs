import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import pg from 'pg';
import { WebSocket } from 'ws';
import { ArtifactStore } from '../apps/api/src/artifacts.ts';
import { AgentRegistryService } from '../apps/api/src/agent-registry.ts';
import { AuthService } from '../apps/api/src/auth.ts';
import { Database } from '../apps/api/src/database.ts';
import { DeliveriesService } from '../apps/api/src/deliveries.ts';
import { pushCandidate } from '../apps/api/src/git-delivery.ts';
import { ProjectsService } from '../apps/api/src/projects.ts';
import { TasksService } from '../apps/api/src/tasks.ts';
import { summarizeItem } from '../apps/worker/src/codex-execution.ts';
import { WorkerJobs } from '../apps/worker/src/jobs.ts';
import { copyRepositoryCache } from '../apps/worker/src/repository-cache.ts';
import { fetchRevisionArtifact, restoreRevision } from '../apps/worker/src/revision-artifact.ts';
import { runVerification } from '../apps/worker/src/verification.ts';

const api = new URL(process.env.ADO_VERIFY_API_URL ?? 'http://127.0.0.1:3101');
const workerApi = new URL(process.env.ADO_VERIFY_WORKER_URL ?? api);
const web = process.env.ADO_VERIFY_WEB_URL ?? 'http://web:3000';
const email = process.env.ADO_BOOTSTRAP_EMAIL;
const password = process.env.ADO_BOOTSTRAP_PASSWORD;
assert(email && password, 'Configure a bootstrap account for the integration check');
const fixtureDatabasePassword = process.env.ADO_VERIFY_MIGRATION_PASSWORD;
assert(fixtureDatabasePassword, 'Provide the migration password of the isolated test fixture');
const db = new pg.Pool({ user: 'ado', password: fixtureDatabasePassword });
const sockets = new Set();
let fixtureRepo;
let workerJournal;
let publisher;
let publisherDb;

async function request(path, { method = 'GET', token, body, status = 200 } = {}) {
  const response = await globalThis.fetch(new URL(path, api), {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, status, `${method} ${path} returned ${response.status}`);
  if (status < 300 && status !== 204) return response.json();
}

async function postForm(url, form, cookie) {
  return globalThis.fetch(url, {
    method: 'POST', body: form, redirect: 'manual',
    headers: { Origin: new URL(web).origin, ...(cookie && { Cookie: cookie }) },
    signal: globalThis.AbortSignal.timeout(30_000),
  });
}

function findFormByButton(html, label) {
  return Array.from(html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g), ([form]) => form)
    .find((form) => Array.from(form.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g), ([, content]) => content)
      .some((content) => content.replace(/<[^>]*>/g, '').trim() === label));
}

async function open(credential, execute = true, verify = false, archive = false, maven = false, revisionArtifacts = false) {
  const endpoint = new URL('/workers/ws', workerApi);
  endpoint.protocol = workerApi.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(endpoint, {
    headers: { Authorization: `Bearer ${credential.workerId}.${credential.token}` },
    handshakeTimeout: 5000,
  });
  ws.on('error', () => ws.terminate());
  sockets.add(ws);
  await once(ws, 'open');
  const send = async (message_type, payload = null) => {
    const id = randomUUID();
    const reply = once(ws, 'message', { signal: globalThis.AbortSignal.timeout(8000) });
    ws.send(JSON.stringify({ message_id: id, worker_id: credential.workerId, message_type, payload,
      timestamp: new Date().toISOString(), correlation_id: null, protocol_version: 1 }));
    const message = JSON.parse((await reply)[0]);
    assert.equal(message.correlation_id, id);
    return message.payload;
  };
  await send('WORKER_REGISTER', {
    os: 'linux', arch: 'x64', nodeVersion: process.version, cpuCount: 2,
    memoryBytes: 1_000_000, diskFreeBytes: 1_000_000, gitVersion: 'git version 2', dockerVersion: null,
    ...(execute && { codexVersion: '0.170.0' }),
    ...(verify && { verificationVersion: 1 }),
    ...(archive && { artifactVersion: 1 }),
    ...(revisionArtifacts && { revisionArtifactVersion: 1 }),
    ...(maven && { mavenVerification: true }),
  });
  const close = async () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    const closed = once(ws, 'close', { signal: globalThis.AbortSignal.timeout(8000) });
    ws.close();
    await closed;
  };
  return { send, close };
}

try {
  const { token } = await request('/auth/session', { method: 'POST', body: { email, password } });
  const suffix = randomBytes(5).toString('hex');
  const project = (code) => request('/projects', {
    token, method: 'POST', body: { code: `${code}-${suffix}`, name: code }, status: 201,
  });
  const first = await project('EXECUTION');
  const second = await project('EXEC-OTHER');
  const credentials = (id) => request(`/projects/${id}/workers`, {
    token, method: 'POST', body: { name: 'Execution fixture' }, status: 201,
  });
  const approved = await credentials(first.id);
  const alternateCredential = await credentials(first.id);
  const foreignCredential = await credentials(second.id);
  const outsider = await open(foreignCredential);
  const observer = await open(await credentials(first.id), false);
  const alternate = await open(alternateCredential);
  let worker = await open(approved);

  // Database fixtures establish a repository binding without contacting GitHub in local CI.
  const { rows: [repository] } = await db.query(
    `INSERT INTO repositories (project_id, github_repository_id, owner, repo_name, repository_url, default_branch, installation_id)
     VALUES ($1, $2, 'test', 'execution-fixture', 'https://github.com/test/execution-fixture', 'main', 1)
     RETURNING id`, [first.id, Number.parseInt(suffix, 16)],
  );

  const tasks = `/projects/${first.id}/tasks`;
  const newTask = async (code, developerRole) => {
    const created = await request(tasks, { token, method: 'POST', status: 201, body: {
      code, title: code, description: 'Exercise the platform execution protocol',
      repositoryId: repository.id, acceptanceCriteria: ['Report tracked file changes'],
    } });
    const base = `${tasks}/${created.id}`;
    for (const status of ['PLANNING', 'WAITING_APPROVAL', 'READY']) {
      await request(`${base}/transition`, { token, method: 'POST',
        body: { status, ...(status === 'READY' && developerRole && { developerRole }) } });
    }
    return { id: created.id, path: base, runs: `${base}/executions` };
  };
  const frontendVersions = `/projects/${first.id}/agent-registry/agents/FRONTEND_DEVELOPER/versions`;
  const pinnedDeveloper = await request(frontendVersions, {
    token, method: 'POST', status: 201, body: { model: 'fixture-codex-approved', instructions: 'Keep the approved behavior.' },
  });
  const task = await newTask('WEB-EXECUTION', 'FRONTEND_DEVELOPER');
  const taskDeveloper = (await request(task.path, { token })).developer;
  assert.deepEqual(taskDeveloper, { role: 'FRONTEND_DEVELOPER', version: pinnedDeveloper.version, model: pinnedDeveloper.model });
  await request(frontendVersions, {
    token, method: 'POST', status: 201, body: { model: 'fixture-codex-later', instructions: 'Later version.' },
  });
  await request(task.runs, { token, method: 'POST', body: { workerId: foreignCredential.workerId }, status: 409 });
  assert.deepEqual(await request(task.runs, { token }), []);
  const home = await globalThis.fetch(web);
  const loginAction = (await home.text()).match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
  assert(loginAction, 'Expected login form');
  const loginForm = new globalThis.FormData();
  loginForm.set(loginAction, '');
  loginForm.set('email', email);
  loginForm.set('password', password);
  const signedIn = await postForm(web, loginForm);
  assert.equal(signedIn.status, 303);
  const cookie = signedIn.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  const selected = new URL(`/?project=${first.id}&task=${task.id}`, web);
  const rendered = await globalThis.fetch(selected, { headers: { Cookie: cookie } });
  assert.equal(rendered.status, 200);
  const workbench = await rendered.text();
  assert(workbench.includes('责任 Agent') && workbench.includes('前端工程师'));
  const formHtml = findFormByButton(workbench, '派发任务');
  const action = formHtml?.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
  assert(action, 'Expected approved task dispatch form');
  assert(formHtml.includes(approved.workerId), 'Expected a project Worker in the dispatch form');
  const dispatch = new globalThis.FormData();
  dispatch.set(action, '');
  dispatch.set('projectId', first.id);
  dispatch.set('taskId', task.id);
  dispatch.set('workerId', approved.workerId);
  assert.equal((await postForm(selected, dispatch, cookie)).status, 303);
  const [initial] = await request(task.runs, { token });
  assert.equal(initial.status, 'queued');
  assert.equal(initial.requestedWorkerId, approved.workerId);
  await request(task.runs, { token, method: 'POST', status: 409 });
  assert.equal(await outsider.send('WORKER_CLAIM'), null);
  assert.equal(await observer.send('WORKER_CLAIM'), null);
  assert.equal(await alternate.send('WORKER_CLAIM'), null);
  const assignmentPath = `${task.runs}/${initial.id}/worker`;
  const assign = (workerId, status = 204) => request(assignmentPath, { token, method: 'POST', body: { workerId }, status });
  const overviewPath = `/projects/${first.id}/operations/overview`;
  const workerAlert = async (taskId) => (await request(overviewPath, { token })).alerts
    .some((alert) => alert.taskId === taskId && alert.kind === 'worker_unavailable');
  await assign(foreignCredential.workerId, 409);
  await assign(alternateCredential.workerId);
  assert.equal(await worker.send('WORKER_CLAIM'), null);
  assert.equal(await workerAlert(task.id), false);
  await alternate.close();
  let alerted = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    alerted = await workerAlert(task.id);
    if (alerted) break;
    await delay(100);
  }
  assert(alerted, 'An offline assigned Worker should alert even when another Worker is online');
  await assign(null);
  assert.equal((await request(task.runs, { token }))[0].requestedWorkerId, null);
  assert.equal(await workerAlert(task.id), false);

  const diskLow = { diskFreeBytes: 32, memoryFreeBytes: 64, minFreeDiskBytes: 128 };
  const diskReady = { ...diskLow, diskFreeBytes: 128, memoryFreeBytes: 256 };
  assert.equal(await worker.send('WORKER_HEARTBEAT', { runId: null, resources: diskLow }), null);
  assert.equal(await worker.send('WORKER_CLAIM'), null);
  assert.equal((await request(overviewPath, { token })).workers.diskPaused, 1);
  assert.equal(await workerAlert(task.id), true);
  const workerState = (await request(`/projects/${first.id}/workers`, { token })).find(({ id }) => id === approved.workerId);
  assert.equal(workerState.status, 'online');
  assert.equal(workerState.capabilities.diskFreeBytes, diskLow.diskFreeBytes);
  assert.equal(workerState.capabilities.memoryFreeBytes, diskLow.memoryFreeBytes);
  assert.equal(await worker.send('WORKER_HEARTBEAT', { runId: null, resources: diskReady }), null);
  assert.equal((await request(overviewPath, { token })).workers.diskPaused, 0);
  assert.equal(await workerAlert(task.id), false);

  const offer = await worker.send('WORKER_CLAIM');
  assert.equal(offer.id, initial.id);
  assert.equal(offer.taskId, task.id);
  await assign(alternateCredential.workerId, 409);
  assert.equal(offer.repository, 'test/execution-fixture');
  assert.equal(offer.development.agent.version, pinnedDeveloper.version);
  assert.equal(offer.development.agent.model, pinnedDeveloper.model);
  assert(offer.development.agent.instructions.includes('Keep the approved behavior.'));
  assert.deepEqual(await worker.send('WORKER_HEARTBEAT', { runId: offer.id, resources: diskLow }), { stop: false });
  assert.equal((await request(overviewPath, { token })).workers.diskPaused, 1);
  assert.equal(await worker.send('WORKER_CLAIM'), null);
  const thread = { runId: offer.id, sequence: 1, kind: 'thread', payload: { threadId: 'fixture-thread' } };
  assert.deepEqual(await worker.send('EXECUTION_EVENT', thread), { stop: false, accepted: true });
  await worker.close();
  worker = await open(approved);
  assert.deepEqual(await worker.send('WORKER_HEARTBEAT', offer.id), { stop: false });
  assert.deepEqual(await worker.send('EXECUTION_EVENT', thread), { stop: false, accepted: true });
  assert.deepEqual(await worker.send('EXECUTION_EVENT', { ...thread, sequence: 3 }), { stop: true, accepted: false });
  const result = { runId: offer.id, sequence: 2, kind: 'result', payload: {
    baseCommit: 'a'.repeat(40), patchHash: 'b'.repeat(64), files: ['index.ts'],
    usage: { inputTokens: 10, cachedInputTokens: 1, outputTokens: 5 },
  } };
  assert.deepEqual(await worker.send('EXECUTION_EVENT', result), { stop: false, accepted: true });
  const [finished] = await request(task.runs, { token });
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.threadId, 'fixture-thread');
  assert.equal((await request(task.path, { token })).status, 'TESTING');
  const events = await request(`${task.runs}/${offer.id}/events`, { token });
  assert.deepEqual(events.map(({ sequence, kind }) => [sequence, kind]), [[1, 'thread'], [2, 'result']]);
  const overview = await globalThis.fetch(selected, { headers: { Cookie: cookie } });
  assert((await overview.text()).includes('变更已生成，待测试'));

  workerJournal = mkdtempSync(join(tmpdir(), 'ado-worker-journal-'));
  const proofRuntime = { root: workerJournal, binary: '', env: {} };
  const interruptedUsage = { inputTokens: 17, cachedInputTokens: 3, outputTokens: 6 };
  const recoverJob = async (code, complete) => {
    const target = await newTask(code);
    const run = await request(target.runs, { token, method: 'POST', status: 201 });
    const jobOffer = await worker.send('WORKER_CLAIM');
    assert.equal(jobOffer.id, run.id);
    const saved = Promise.withResolvers();
    const beforeRestart = new WorkerJobs(proofRuntime, approved.workerId, async () => true, async (_runtime, _offer, emit) => {
      try {
        await emit('thread', { threadId: 'restart-fixture' });
        await emit('progress', { stage: 'collecting' });
        if (complete) await emit('result', result.payload);
        else await emit('turn', { attempt: 1, phase: 'completed', durationMs: 150, usage: interruptedUsage });
        saved.resolve();
      } catch (error) {
        saved.reject(error);
      }
    });
    await beforeRestart.start(jobOffer);
    await saved.promise;
    await assert.rejects(beforeRestart.flush(async (event) => {
      assert.equal((await worker.send('EXECUTION_EVENT', event)).accepted, true);
      throw new Error('Lost acknowledgement');
    }), /Lost acknowledgement/);
    const { state } = await outsider.send('WORKER_RECOVER', run.id);
    assert.equal(state, 'unavailable');
    beforeRestart.cancel();
    await worker.close();
    worker = await open(approved);
    let restartedExecution = false;
    const afterRestart = new WorkerJobs(proofRuntime, approved.workerId, async () => true, async () => {
      restartedExecution = true;
    });
    await afterRestart.load();
    assert.equal(afterRestart.runId, run.id);
    const recovery = await worker.send('WORKER_RECOVER', run.id);
    assert.deepEqual(recovery, { state: 'running', lastSequence: 1 });
    await afterRestart.reconcile(recovery);
    await afterRestart.flush((event) => worker.send('EXECUTION_EVENT', event));
    await afterRestart.flush((event) => worker.send('EXECUTION_EVENT', event));
    if (!complete) await afterRestart.flush((event) => worker.send('EXECUTION_EVENT', event));
    assert.equal(afterRestart.runId, null);
    assert.equal(restartedExecution, false);
    assert.equal((await request(target.path, { token })).status, complete ? 'TESTING' : 'FAILED');
    const kinds = complete ? ['thread', 'progress', 'result'] : ['thread', 'progress', 'turn', 'failed'];
    assert.deepEqual(await worker.send('WORKER_RECOVER', run.id), { state: 'finished', lastSequence: kinds.length });
    const restored = await request(`${target.runs}/${run.id}/events`, { token });
    assert.deepEqual(restored.map(({ sequence, kind }) => [sequence, kind]),
      kinds.map((kind, index) => [index + 1, kind]));
    if (!complete) {
      assert.deepEqual(restored[2].payload.usage, interruptedUsage);
      assert.equal(restored[3].payload.code, 'worker_restarted');
    }
    const savedEvents = JSON.parse(readFileSync(join(workerJournal, `${run.id}.events.json`), 'utf8'));
    assert.equal(savedEvents.events.length, kinds.length);
    assert(!Object.hasOwn(savedEvents, 'repositoryToken'));
  };
  await recoverJob('RECOVER-COMPLETE', true);
  await recoverJob('RECOVER-INTERRUPTED', false);

  const backendUsage = async () => {
    const { usage } = await request(`/projects/${first.id}/operations`, { token });
    const backend = usage.filter(({ role }) => role === 'BACKEND_DEVELOPER');
    return ['inputTokens', 'cachedInputTokens', 'outputTokens']
      .map((key) => backend.reduce((total, row) => total + Number(row[key]), 0));
  };
  assert.deepEqual(await backendUsage(), [27, 4, 11]);

  const cancelled = await newTask('CANCEL-EXECUTION');
  const secondRun = await request(cancelled.runs, { token, method: 'POST', status: 201 });
  const cancelledOffer = await worker.send('WORKER_CLAIM');
  assert.equal(cancelledOffer.id, secondRun.id);
  assert.equal(cancelledOffer.turnUsage, true);
  const ledgerSaved = Promise.withResolvers();
  const latestUsage = { inputTokens: 20, cachedInputTokens: 5, outputTokens: 9 };
  const cancelledJob = new WorkerJobs(proofRuntime, approved.workerId, async () => true, async (_runtime, _offer, emit) => {
    try {
      await emit('turn', { attempt: 1, phase: 'completed', durationMs: 140, usage: interruptedUsage });
      await emit('turn', { attempt: 2, phase: 'completed', durationMs: 210, usage: latestUsage });
      ledgerSaved.resolve();
    } catch (error) {
      ledgerSaved.reject(error);
    }
  });
  await cancelledJob.start(cancelledOffer);
  await ledgerSaved.promise;
  await request(`${cancelled.runs}/${secondRun.id}/cancel`, { token, method: 'POST', status: 204 });
  assert.deepEqual(await worker.send('WORKER_RECOVER', secondRun.id), { state: 'cancelling', lastSequence: 0 });
  assert.deepEqual(await worker.send('WORKER_HEARTBEAT', secondRun.id), { stop: true });
  cancelledJob.cancel();
  const sendCancelled = (event) => worker.send('EXECUTION_EVENT', event);
  await assert.rejects(cancelledJob.flush(async (event) => {
    assert.deepEqual(await sendCancelled(event), { stop: false, accepted: true });
    throw new Error('Lost cancellation acknowledgement');
  }), /Lost cancellation acknowledgement/);
  await cancelledJob.flush(sendCancelled);
  assert.equal((await request(cancelled.path, { token })).status, 'CANCELLED');
  const cancellationEvents = await request(`${cancelled.runs}/${secondRun.id}/events`, { token });
  assert.equal(cancellationEvents.length, 1);
  assert.deepEqual(cancellationEvents[0].payload, { usage: latestUsage });
  assert.deepEqual(await backendUsage(), [47, 9, 20]);
  console.log('Codex usage from completed turns survived interrupted runs, cancellation and event replay');

  const timed = await newTask('TIMEOUT-EXECUTION');
  await db.query('UPDATE tasks SET approved_developer = NULL WHERE id = $1', [timed.id]);
  const timedRun = await request(timed.runs, { token, method: 'POST', status: 201 });
  const legacyOffer = await worker.send('WORKER_CLAIM');
  assert.equal(legacyOffer.id, timedRun.id);
  assert.equal(legacyOffer.development.agent.role, 'BACKEND_DEVELOPER');
  assert.equal((await request(timed.path, { token })).developer.role, 'BACKEND_DEVELOPER');
  await worker.close();
  await db.query("UPDATE execution_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [timedRun.id]);
  let timedOut = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await request(timed.path, { token });
    if (result.status === 'TIMEOUT') { timedOut = true; break; }
    await delay(250);
  }
  assert(timedOut, 'Expected expired lease to time out');
  const retry = await request(timed.runs, { token, method: 'POST', status: 201 });
  assert.notEqual(retry.id, timedRun.id);
  assert.equal(retry.status, 'queued');
  await request(`${timed.runs}/${retry.id}/cancel`, { token, method: 'POST', status: 204 });

  const checksPath = `/projects/${first.id}/repositories/${repository.id}/checks`;
  const plan = [{ name: 'unit', kind: 'unit', argv: ['node', '--test'], directory: '.', timeoutSeconds: 30 }];
  const mavenPlan = [{ ...plan[0], name: 'server', argv: ['mvn', 'test'] }];
  await request(checksPath, { token, method: 'PATCH', body: { checks: mavenPlan } });
  const nodeCredential = await credentials(first.id);
  const nodeWorker = await open(nodeCredential, true, true, true);
  const serverTask = await newTask('MAVEN-ROUTING');
  await request(serverTask.runs, { token, method: 'POST', body: { workerId: nodeCredential.workerId }, status: 409 });
  const mavenRun = await request(serverTask.runs, { token, method: 'POST', status: 201 });
  const mavenAssign = `${serverTask.runs}/${mavenRun.id}/worker`;
  await request(mavenAssign, { token, method: 'POST', body: { workerId: nodeCredential.workerId }, status: 409 });
  assert.equal(await nodeWorker.send('WORKER_CLAIM'), null);

  const nodePlan = [{ ...plan[0], argv: ['node', '--test', 'mvn'] }];
  await request(checksPath, { token, method: 'PATCH', body: { checks: nodePlan } });
  const serverPage = new URL(`/?project=${first.id}&task=${serverTask.id}`, web);
  const waitingPage = await globalThis.fetch(serverPage, { headers: { Cookie: cookie } });
  const waitingHtml = await waitingPage.text();
  assert(waitingHtml.includes('当前分配范围内没有可领取任务的 Maven Worker'));
  assert(waitingHtml.includes('暂无符合条件的在线 Worker'));
  assert.equal(await workerAlert(serverTask.id), true);
  assert.deepEqual((await request(serverTask.runs, { token }))[0].checkPlan, mavenPlan);
  const nodeTask = await newTask('NODE-ROUTING');
  const nodeRun = await request(nodeTask.runs, { token, method: 'POST', status: 201 });
  const nodeOffer = await nodeWorker.send('WORKER_CLAIM');
  assert.equal(nodeOffer.id, nodeRun.id);
  assert.equal(nodeOffer.detailedEvents, true);
  const rawCommand = { type: 'item.completed', item: { id: 'item_1', type: 'command_execution',
    status: 'failed', exit_code: 7, command: 'private fixture command', aggregated_output: 'private fixture output' } };
  const commandSummary = { itemType: 'command_execution', phase: 'completed', status: 'failed', exitCode: 7 };
  assert.deepEqual(summarizeItem(rawCommand, true), commandSummary);
  assert.deepEqual(summarizeItem(rawCommand, false), { itemType: 'command_execution', phase: 'completed' });
  const tool = { type: 'item.completed', item: { id: 'item_2', type: 'mcp_tool_call', status: 'completed',
    server: 'local', tool: 'probe', arguments: { value: 'private fixture arguments' } } };
  const toolSummary = summarizeItem(tool, true);
  assert.deepEqual(toolSummary, { itemType: 'mcp_tool_call', phase: 'completed', status: 'completed' });
  assert.equal(summarizeItem(tool, false), undefined);
  const logs = [
    { kind: 'thread', payload: { threadId: 'timeline-fixture' } },
    { kind: 'turn', payload: { phase: 'started', attempt: 1 } },
    { kind: 'item', payload: { ...commandSummary, command: rawCommand.item.command, output: rawCommand.item.aggregated_output } },
    { kind: 'item', payload: toolSummary },
    { kind: 'turn', payload: { phase: 'completed', attempt: 1, durationMs: 1200, error: 'private fixture error' } },
  ];
  for (const [index, event] of logs.entries()) {
    const message = { runId: nodeRun.id, sequence: index + 1, ...event };
    assert.equal((await nodeWorker.send('EXECUTION_EVENT', message)).accepted, true);
    assert.equal((await nodeWorker.send('EXECUTION_EVENT', message)).accepted, true);
  }
  const timeline = await request(`${nodeTask.runs}/${nodeRun.id}/events`, { token });
  assert.equal(timeline.length, logs.length);
  assert.deepEqual(timeline[2].payload, commandSummary);
  assert.deepEqual(timeline[4].payload, { phase: 'completed', attempt: 1, durationMs: 1200 });
  assert(!JSON.stringify(timeline).includes('private fixture'));
  const timelinePage = new URL(`/?project=${first.id}&task=${nodeTask.id}`, web);
  const renderedTimeline = await (await globalThis.fetch(timelinePage, { headers: { Cookie: cookie } })).text();
  assert(renderedTimeline.includes('命令执行 · 失败 · 退出码 7'));
  assert(renderedTimeline.includes('第 1 轮 Codex · 完成 · 1.20 秒'));
  assert(!renderedTimeline.includes('private fixture'));
  console.log('Codex timeline replay, structured outcomes and sensitive field filtering passed');

  const mavenCredential = await credentials(first.id);
  const mavenWorker = await open(mavenCredential, true, true, true, true);
  assert.equal(await workerAlert(serverTask.id), false);
  await request(mavenAssign, { token, method: 'POST', body: { workerId: mavenCredential.workerId }, status: 204 });
  await request(mavenAssign, { token, method: 'POST', body: { workerId: null }, status: 204 });
  const mavenOffer = await mavenWorker.send('WORKER_CLAIM');
  assert.equal(mavenOffer.id, mavenRun.id);
  assert.deepEqual(mavenOffer.checks, mavenPlan);
  for (const [task, run, client] of [[nodeTask, nodeRun, nodeWorker], [serverTask, mavenRun, mavenWorker]]) {
    await request(`${task.runs}/${run.id}/cancel`, { token, method: 'POST', status: 204 });
    assert.equal((await client.send('EXECUTION_EVENT', {
      runId: run.id, sequence: run.id === nodeRun.id ? logs.length + 1 : 1, kind: 'cancelled', payload: {},
    })).accepted, true);
    await client.close();
  }
  console.log('Maven-aware assignment and claiming honored the queued check plan with two Workers');
  console.log('Queued task alerts tracked assignment, connectivity, disk pressure and tool support');
  await request(checksPath, { token, method: 'PATCH', body: { checks: [{ ...plan[0], directory: '../other' }] }, status: 400 });
  const configured = await request(checksPath, { token, method: 'PATCH', body: { checks: plan } });
  assert.deepEqual(configured.checks, plan);
  const rerun = await request(task.runs, { token, method: 'POST', status: 201 });
  assert.equal(rerun.status, 'queued');
  await request(`${task.runs}/${rerun.id}/cancel`, { token, method: 'POST', status: 204 });
  const verified = await newTask('VERIFY-AND-REPAIR');
  const active = await request(verified.runs, { token, method: 'POST', status: 201 });
  const reviewPath = `${verified.runs}/${active.id}/review`;
  const approve = { token, method: 'POST', body: { decision: 'approved' } };
  await request(reviewPath, { ...approve, status: 409 });
  await request(checksPath, { token, method: 'PATCH', body: { checks: [...plan, { ...plan[0], name: 'later' }] } });
  worker = await open(approved);
  assert.equal(await worker.send('WORKER_CLAIM'), null);
  await worker.close();
  worker = await open(approved, true, true, true);
  const testOffer = await worker.send('WORKER_CLAIM');
  assert.equal(testOffer.id, active.id);
  assert.deepEqual(testOffer.checks, plan);
  assert.equal(testOffer.archivePatch, true);
  const sendEvent = (sequence, kind, payload) => worker.send('EXECUTION_EVENT', { runId: active.id, sequence, kind, payload });
  assert.equal((await sendEvent(1, 'thread', { threadId: 'review-fixture' })).accepted, true);
  fixtureRepo = mkdtempSync(join(tmpdir(), 'ado-release-fixture-'));
  const git = (...args) => execFileSync('git', args, { cwd: fixtureRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const shim = join(workerJournal, 'check-sandbox-fixture');
  writeFileSync(shim, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = -- ]; then shift; exec /usr/bin/env -u PATH "$@"; fi\n  shift\ndone\nexit 126\n',
    { mode: 0o700 });
  const verifyFixture = (name, argv, directory = '.') => ({ name, kind: 'unit', argv, directory, timeoutSeconds: 1 });
  const [failedCheck, timeoutCheck, directoryCheck, toolCheck, passingCheck] = await runVerification({
    binary: shim, worktree: fixtureRepo, profile: [], env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
  }, [
    verifyFixture('failed', ['node', '-e', 'process.stderr.write("older".repeat(1800)+"\u001b[0m expected assertion\\n");process.exitCode=1']),
    verifyFixture('deadline', ['node', '-e', 'setTimeout(() => {}, 5000)']),
    verifyFixture('directory', ['node', '-e', ''], 'missing'),
    verifyFixture('tool', ['ado-this-tool-does-not-exist']),
    verifyFixture('passing', ['node', '-e', 'process.stdout.write("success")']),
  ], globalThis.AbortSignal.timeout(8000));
  assert.deepEqual([failedCheck, timeoutCheck, directoryCheck, toolCheck, passingCheck].map(({ result: value }) => value.reason),
    ['nonzero_exit', 'timeout', 'directory_unavailable', 'executable_unavailable', undefined]);
  assert(failedCheck.diagnostic.endsWith('expected assertion'));
  assert(Buffer.byteLength(failedCheck.diagnostic) <= 4096);
  assert.equal(failedCheck.diagnostic.includes('\u001b'), false);
  assert.equal(passingCheck.diagnostic, undefined);
  const cacheRoot = join(workerJournal, 'repository-caches');
  const source = join(cacheRoot, 'test', 'execution-fixture', '_cacache');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'cached-entry'), 'repository-cache');
  const cacheSignal = globalThis.AbortSignal.timeout(5000);
  assert.equal(await copyRepositoryCache(cacheRoot, 'test/other-project', workerJournal, 'npm', cacheSignal), undefined);
  symlinkSync(join(cacheRoot, 'test', 'execution-fixture'), join(cacheRoot, 'test', 'aliased-project'));
  await assert.rejects(copyRepositoryCache(cacheRoot, 'test/aliased-project', workerJournal, 'npm', cacheSignal), /symbolic path/);
  const npmCache = await copyRepositoryCache(cacheRoot, 'TEST/Execution-Fixture', workerJournal, 'npm', cacheSignal);
  const [cacheCheck] = await runVerification({
    binary: shim, worktree: fixtureRepo, profile: [], env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, npmCache,
  }, [verifyFixture('offline-cache', ['node', '-e',
    'const fs=require("node:fs"), env=process.env, p=env.npm_config_cache+"/_cacache/cached-entry"; if(!env.PATH||env.HOME!==env.npm_config_cache||env.npm_config_offline!=="true"||fs.readFileSync(p,"utf8")!=="repository-cache") process.exit(1); fs.writeFileSync(p,"job-local");',
  ])], cacheSignal);
  assert.equal(cacheCheck.result.status, 'passed');
  assert.equal(readFileSync(join(source, 'cached-entry'), 'utf8'), 'repository-cache');
  const mavenSource = join(cacheRoot, 'test', 'execution-fixture', 'repository');
  mkdirSync(mavenSource);
  writeFileSync(join(mavenSource, 'cached-entry'), 'maven-seed');
  const mavenCache = await copyRepositoryCache(cacheRoot, 'test/execution-fixture', workerJournal, 'maven', cacheSignal);
  writeFileSync(join(workerJournal, 'mvn'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { HOME, TMPDIR, JAVA_TOOL_OPTIONS } = process.env;
const repository = HOME + '/repository';
assert.deepEqual(process.argv.slice(2), ['--offline', '-Dmaven.repo.local=' + repository, 'verify']);
assert.equal(TMPDIR, HOME + '/tmp');
assert.equal(JAVA_TOOL_OPTIONS, '-Duser.home="' + HOME + '" -Djava.io.tmpdir="' + TMPDIR + '"');
assert.equal(fs.readFileSync(repository + '/cached-entry', 'utf8'), 'maven-seed');
fs.writeFileSync(repository + '/cached-entry', 'job-local');
fs.writeFileSync(TMPDIR + '/probe', '');
`, { mode: 0o700 });
  const [mavenCheck] = await runVerification({
    binary: shim, worktree: fixtureRepo, profile: [], mavenCache,
    env: { PATH: `${workerJournal}:${dirname(process.execPath)}:/usr/bin:/bin` },
  }, [verifyFixture('offline-maven', ['mvn', 'verify'])], cacheSignal);
  assert.equal(mavenCheck.result.status, 'passed', mavenCheck.diagnostic);
  assert.equal(readFileSync(join(mavenSource, 'cached-entry'), 'utf8'), 'maven-seed');
  git('init', '-q', '-b', 'main');
  writeFileSync(join(fixtureRepo, 'index.ts'), 'old\n');
  git('add', 'index.ts');
  git('-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base');
  const baseline = git('rev-parse', 'HEAD').trim();
  const candidate = (attempt, patchHash) => ({ ...result.payload, baseCommit: baseline, attempt, patchHash });
  const check = (passed) => [{ name: 'unit', durationMs: 20, status: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1,
    ...(!passed && { reason: 'nonzero_exit', diagnostic: 'private fixture text' }) }];
  const initialHash = 'c'.repeat(64);
  const patchBytes = Buffer.from('diff --git a/index.ts b/index.ts\n--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-old\n+new\n');
  const repairedHash = createHash('sha256').update(patchBytes).digest('hex');
  assert.equal((await sendEvent(2, 'result', candidate(1, initialHash))).accepted, true);
  assert.equal((await request(verified.path, { token })).status, 'TESTING');
  assert.equal((await sendEvent(3, 'verification', { attempt: 1, patchHash: repairedHash, checks: check(true) })).accepted, false);
  assert.equal((await sendEvent(3, 'verification', { attempt: 1, patchHash: initialHash, checks: check(false) })).accepted, true);
  assert.equal((await request(verified.runs, { token }))[0].status, 'running');
  await request(reviewPath, { ...approve, status: 409 });
  assert.equal((await sendEvent(4, 'result', candidate(2, repairedHash))).accepted, true);
  const passing = { attempt: 2, patchHash: repairedHash, checks: check(true) };
  assert.equal((await sendEvent(5, 'verification', passing)).accepted, false);
  const upload = async (runId, credential, bytes, expected) => {
    const response = await globalThis.fetch(new URL(`/worker-executions/${runId}/artifact`, workerApi), {
      method: 'PUT', body: bytes,
      headers: { Authorization: `Bearer ${credential.workerId}.${credential.token}`, 'Content-Type': 'application/octet-stream' },
      signal: globalThis.AbortSignal.timeout(12000),
    });
    assert.equal(response.status, expected);
    if (response.ok) {
      assert.deepEqual(await response.json(), { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    }
  };
  await upload(active.id, foreignCredential, patchBytes, 404);
  await upload(active.id, approved, Buffer.from('mismatched bytes'), 409);
  await upload(active.id, approved, patchBytes, 200);
  await upload(active.id, approved, patchBytes, 200);
  const autoApprovalPath = `/projects/${first.id}/auto-approval`;
  const setAutoApproval = (READY, REVIEW) => request(autoApprovalPath, { token, method: 'PUT', body: { READY, REVIEW } });
  await setAutoApproval(false, true);
  assert.equal((await sendEvent(5, 'verification', passing)).accepted, true);
  assert.equal((await sendEvent(5, 'verification', passing)).accepted, true);
  assert.equal((await request(verified.path, { token })).status, 'REVIEW');
  const reviewEvents = () => request(`${verified.path}/events`, { token });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await reviewEvents()).some(({ eventType }) => eventType === 'task.auto_approval_failed')) break;
    await delay(250);
  }
  const skippedReview = (await reviewEvents()).filter(({ eventType }) => eventType.startsWith('task.auto_approval_'));
  assert.equal(skippedReview.length, 1);
  assert.equal(skippedReview[0].eventType, 'task.auto_approval_failed');
  assert.equal(skippedReview[0].payload.reason, 'Repository automatic draft PR is disabled');
  assert.equal((await request(verified.runs, { token }))[0].review, null);
  assert.equal((await request(verified.path, { token })).status, 'REVIEW');
  await setAutoApproval(false, false);
  const reviewPage = new URL(`/?project=${first.id}&task=${verified.id}`, web);
  const deliveryPath = `${verified.runs}/${active.id}/delivery`;
  await request(deliveryPath, { token, method: 'POST', status: 409 });
  await request(`/projects/${second.id}/tasks/${verified.id}/executions/${active.id}/artifact`, { token, status: 404 });
  const downloaded = await globalThis.fetch(new URL(`/artifacts/${first.id}/${verified.id}/${active.id}`, web),
    { headers: { Cookie: cookie } });
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), patchBytes);
  const pendingReview = await globalThis.fetch(reviewPage, { headers: { Cookie: cookie } });
  const approvalForm = findFormByButton(await pendingReview.text(), '批准变更');
  const approvalAction = approvalForm?.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
  assert(approvalAction, 'Expected a human review form after checks passed');
  const approveForm = new globalThis.FormData();
  approveForm.set(approvalAction, '');
  approveForm.set('projectId', first.id);
  approveForm.set('taskId', verified.id);
  approveForm.set('runId', active.id);
  approveForm.set('decision', 'approved');
  approveForm.set('comment', '');
  assert.equal((await postForm(reviewPage, approveForm, cookie)).status, 303);
  assert.equal((await request(reviewPath, approve)).decision, 'approved');
  await request(reviewPath, { token, method: 'POST', body: { decision: 'rejected', comment: 'Changed my mind' }, status: 409 });
  const [reviewed] = await request(verified.runs, { token });
  assert.equal(reviewed.report.patchHash, repairedHash);
  assert.equal(reviewed.review.decision, 'approved');
  assert.deepEqual(reviewed.artifact, { sha256: repairedHash, size: patchBytes.length });
  const reportPage = await globalThis.fetch(reviewPage, { headers: { Cookie: cookie } });
  const reportHtml = (await reportPage.text()).replace(/<!--[\s\S]*?-->/g, '');
  assert(reportHtml.includes('第 2 次检查报告') && reportHtml.includes('已批准'));
  assert(reportHtml.includes('第 1 次检查报告') && reportHtml.includes('检查命令返回非零退出码'));
  assert(!reportHtml.includes('private fixture text'));
  assert(reportHtml.includes('发布分支并创建草稿 PR'));
  if (!process.env.GITHUB_APP_ID) await request(deliveryPath, { token, method: 'POST', status: 503 });

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (webhookSecret) {
    const branch = `ado/${active.id}`;
    publisherDb = new Database();
    const projects = new ProjectsService(publisherDb, new AuthService(publisherDb));
    let pullCalls = 0;
    let snapshot;
    let closeoutChecksPassed = false;
    const github = {
      configured: true,
      async readPull(install, repo, repositoryName, number) {
        assert.equal(install, 1);
        assert.equal(repo, Number.parseInt(suffix, 16));
        assert.equal(repositoryName, 'test/execution-fixture');
        assert([2, 3].includes(number));
        return snapshot;
      },
      async verifyMergedDelivery(install, repo, repositoryName, pull) {
        assert.equal(repo, Number.parseInt(suffix, 16));
        assert.equal(pull.number, 2);
        assert.equal(pull.merged, true);
        if (!closeoutChecksPassed) throw new Error('Final CI has not passed');
        return { mergeSha: 'e'.repeat(40), ciRunId: 7, ciAttempt: 1, authorization: 'owner_gate', gateCheckId: 8 };
      },
      async deliveryToken(install, repo) {
        assert.equal(install, 1);
        assert.equal(repo, Number.parseInt(suffix, 16));
        return 'release-fixture-token';
      },
      async draftPull(credential, repositoryName, head, base, commit, title, body) {
        assert.equal(credential, 'release-fixture-token');
        assert.equal(repositoryName, 'test/execution-fixture');
        assert.equal(head.startsWith('ado/'), true);
        assert.equal(base, 'main');
        assert.equal(git('rev-parse', head).trim(), commit);
        assert.equal(git('show', `${commit}:index.ts`), 'new\n');
        assert.match(title, /^\[(VERIFY-AND-REPAIR|AUTO-DRAFT-PR|ABANDONED-PR)\]/);
        assert(body.includes('Changed files') && body.includes('index.ts') && body.includes('unit') && body.includes(repairedHash));
        if (title.startsWith('[AUTO-DRAFT-PR]')) {
          assert(body.includes('Independent verification') && body.includes('browser') && body.includes('dependency'));
        }
        pullCalls++;
        return { number: pullCalls, url: `https://github.com/test/execution-fixture/pull/${pullCalls}`,
          updatedAt: '2026-01-01T00:00:00Z', state: 'open' };
      },
    };
    const publisherTasks = new TasksService(publisherDb, projects, new AgentRegistryService(publisherDb, projects));
    publisher = new DeliveriesService(publisherDb, publisherTasks, projects,
      github, new ArtifactStore(), (input, signal) => {
        assert.equal(input.remote, 'https://github.com/test/execution-fixture.git');
        assert.equal(input.baseCommit, baseline);
        return pushCandidate({ ...input, remote: fixtureRepo, token: undefined }, signal);
      });
    const actor = await request('/auth/session', { token });
    assert.equal((await publisher.enqueue(actor, first.id, verified.id, active.id)).state, 'queued');
    assert.equal((await publisher.enqueue(actor, first.id, verified.id, active.id)).state, 'queued');
    publisher.onModuleInit();
    let publication;
    for (let attempt = 0; attempt < 60; attempt++) {
      publication = (await request(verified.runs, { token }))[0].delivery;
      if (publication.state === 'published' || publication.state === 'failed') break;
      await delay(250);
    }
    assert.equal(publication.state, 'published', publication.error ?? 'Publication did not finish');
    assert.equal(pullCalls, 1);
    const sha = git('rev-parse', branch).trim();
    assert.equal(publication.commitSha, sha);
    assert.equal(git('rev-parse', 'main').trim(), baseline);
    const webhook = async (kind, event, id = randomUUID(), valid = true) => {
      const body = JSON.stringify({
        repository: { id: Number.parseInt(suffix, 16) }, installation: { id: 1 }, ...event,
      });
      const digest = createHmac('sha256', webhookSecret).update(body).digest('hex');
      const response = await globalThis.fetch(new URL('/github/webhook', api), {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/json', 'X-GitHub-Delivery': id, 'X-GitHub-Event': kind,
          'X-Hub-Signature-256': `sha256=${valid ? digest : '0'.repeat(64)}` },
        signal: globalThis.AbortSignal.timeout(10000),
      });
      assert.equal(response.status, valid ? 204 : 401);
    };
    const runnerEvent = { check_run: { head_sha: sha, status: 'completed', conclusion: 'success' } };
    const deliveryId = randomUUID();
    await webhook('check_run', runnerEvent, deliveryId, false);
    await webhook('check_run', runnerEvent, deliveryId);
    await webhook('check_run', runnerEvent, deliveryId);
    const history = await request(`${verified.path}/events`, { token });
    assert.equal(history.filter(({ eventType }) => eventType === 'task.github_check').length, 1);
    const wrong = 'f'.repeat(40);
    await webhook('push', { ref: `refs/heads/${branch}`, after: wrong });
    const pull = (head, updated_at, base = 'main') => ({ pull_request: { number: 1, state: 'closed', merged: true,
      updated_at, head: { sha: head, ref: branch }, base: { ref: base } } });
    await webhook('pull_request', pull(wrong, '2026-01-02T00:00:00Z'));
    assert.equal((await request(verified.path, { token })).status, 'REVIEW');
    assert.equal((await request(verified.runs, { token }))[0].delivery.pullState, 'changed');
    await webhook('pull_request', pull(sha, '2026-01-02T00:00:01Z', 'staging'));
    assert.equal((await request(verified.path, { token })).status, 'REVIEW');
    await webhook('pull_request', pull(sha, '2026-01-02T00:00:02Z'));
    assert.equal((await request(verified.path, { token })).status, 'COMPLETED');
    assert.equal((await request(verified.runs, { token }))[0].delivery.pullState, 'merged');

    await request(checksPath, { token, method: 'PATCH', body: { checks: plan, autoDraftPr: 'true' }, status: 400 });
    const independentChecks = [{ name: 'browser', kind: 'browser' }, { name: 'dependency', kind: 'dependency' }];
    await request(checksPath, { token, method: 'PATCH', body: { checks: [], independentChecks }, status: 400 });
    const autoSetting = await request(checksPath, { token, method: 'PATCH', body: { checks: plan, independentChecks, autoDraftPr: true } });
    assert.equal(autoSetting.autoDraftPr, true);
    assert.deepEqual(autoSetting.independentChecks, independentChecks);
    const automatic = await newTask('AUTO-DRAFT-PR');
    const autoRun = await request(automatic.runs, { token, method: 'POST', status: 201 });
    await request(checksPath, { token, method: 'PATCH', body: { checks: plan, independentChecks: [] } });
    assert.equal((await worker.send('WORKER_CLAIM')).id, autoRun.id);
    const reportAuto = (sequence, kind, payload) =>
      worker.send('EXECUTION_EVENT', { runId: autoRun.id, sequence, kind, payload });
    assert.equal((await reportAuto(1, 'thread', { threadId: 'auto-pr-fixture' })).accepted, true);
    assert.equal((await reportAuto(2, 'result', candidate(1, repairedHash))).accepted, true);
    await upload(autoRun.id, approved, patchBytes, 200);
    assert.equal((await reportAuto(3, 'verification', { ...passing, attempt: 1 })).accepted, true);
    const verifiedRun = (await request(automatic.runs, { token }))[0];
    assert.equal(verifiedRun.delivery, null);
    assert.deepEqual(verifiedRun.independentChecks, independentChecks);
    const autoReview = `${automatic.runs}/${autoRun.id}/review`;
    const submitEvidence = (name, status, extra = {}, expected = 201) => request(`${automatic.runs}/${autoRun.id}/evidence`, {
      token, method: 'POST', status: expected,
      body: { patchHash: repairedHash, summary: 'Independent check on the archived patch',
        check: { name, status, source: 'archive', environment: 'Synthetic fixture', ...extra } },
    });
    await request(autoReview, { ...approve, status: 409 });
    await request(`${automatic.runs}/${autoRun.id}/evidence`, { token, method: 'POST', status: 201,
      body: { patchHash: repairedHash, summary: 'Free text remains separate from required results' } });
    await submitEvidence('browser', 'passed', { source: 'github_ci' }, 400);
    await submitEvidence('unplanned', 'passed', {}, 409);
    await submitEvidence('browser', 'failed');
    await submitEvidence('dependency', 'passed');
    await request(autoReview, { ...approve, status: 409 });
    const blocked = (await request(automatic.runs, { token }))[0];
    assert.equal(blocked.review, null);
    assert.equal(blocked.delivery, null);
    assert.equal(pullCalls, 1);
    const blockedPage = await globalThis.fetch(new URL(`/?project=${first.id}&task=${automatic.id}`, web), { headers: { Cookie: cookie } });
    const blockedHtml = await blockedPage.text();
    assert(blockedHtml.includes('必需检查尚未通过') && blockedHtml.includes('登记独立复验'));
    assert.match(blockedHtml, /<button(?=[^>]*\bdisabled)(?=[^>]*\bvalue="approved")[^>]*>/);
    const evidenceAction = findFormByButton(blockedHtml, '登记独立复验')?.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
    assert(evidenceAction, 'Expected independent verification form');
    const passingForm = new globalThis.FormData();
    for (const [key, value] of Object.entries({
      [evidenceAction]: '', projectId: first.id, taskId: automatic.id, runId: autoRun.id, patchHash: repairedHash,
      checkName: 'browser', checkStatus: 'passed', environment: 'Narrow viewport fixture', summary: 'Passed on retest', url: '',
    })) passingForm.set(key, value);
    const saved = await postForm(blockedPage.url, passingForm, cookie);
    assert.equal(saved.status, 303);
    assert.match(saved.headers.get('location'), /notice=execution-evidence-saved/);
    const decisions = await Promise.all([request(autoReview, approve), request(autoReview, approve)]);
    assert.deepEqual(decisions[0], decisions[1]);
    let draft;
    for (let attempt = 0; attempt < 60; attempt++) {
      draft = (await request(automatic.runs, { token }))[0].delivery;
      if (draft?.state === 'published' || draft?.state === 'failed') break;
      await delay(250);
    }
    assert.equal(draft?.state, 'published', draft?.error ?? 'Approval did not publish the draft pull request');
    assert.equal(draft.pullNumber, 2);
    assert.equal(draft.commitSha, git('rev-parse', `ado/${autoRun.id}`).trim());
    assert.equal(pullCalls, 2);
    const autoEvents = (await request(`${automatic.path}/events`, { token }))
      .filter(({ eventType }) => eventType === 'task.delivery_queued');
    assert.equal(autoEvents.length, 1);
    assert.equal(autoEvents[0].payload.automatic, true);
    assert.equal((await request(automatic.path, { token })).status, 'REVIEW');
    assert.equal(git('rev-parse', 'main').trim(), baseline);
    const deliveryPage = new URL(`/?project=${first.id}&task=${automatic.id}`, web);
    const hasSyncButton = async () => (await (await globalThis.fetch(deliveryPage, {
      headers: { Cookie: cookie },
    })).text()).includes('同步 GitHub PR 状态');
    assert.equal(await hasSyncButton(), true);
    const refreshPath = `${automatic.runs}/${autoRun.id}/delivery/refresh`;
    await request(refreshPath, { method: 'POST', status: 401 });
    if (!process.env.GITHUB_APP_ID) await request(refreshPath, { token, method: 'POST', status: 503 });
    await assert.rejects(publisher.refreshPull(actor, second.id, automatic.id, autoRun.id), /not found/);
    const refresh = () => publisher.refreshPull(actor, first.id, automatic.id, autoRun.id);
    snapshot = { state: 'closed', merged: true, updated_at: '2025-12-31T00:00:00Z',
      head: { sha: draft.commitSha, ref: draft.branch }, base: { ref: draft.baseBranch } };
    await refresh();
    assert.equal((await request(automatic.runs, { token }))[0].delivery.pullState, 'open');
    snapshot = { ...snapshot, updated_at: '2026-01-02T00:00:00Z', head: { ...snapshot.head, sha: wrong } };
    await refresh();
    assert.equal((await request(automatic.runs, { token }))[0].delivery.pullState, 'changed');
    assert.equal((await request(automatic.path, { token })).status, 'REVIEW');
    const closeoutPath = `${automatic.runs}/${autoRun.id}/delivery/closeout`;
    await request(closeoutPath, { method: 'POST', body: { outcome: 'completed' }, status: 401 });
    const complete = () => publisher.closeOut(actor, first.id, automatic.id, autoRun.id, { outcome: 'completed' });
    snapshot = { ...snapshot, number: 2, head: { ...snapshot.head, repo: { id: Number.parseInt(suffix, 16) } } };
    await assert.rejects(publisher.closeOut(actor, first.id, automatic.id, autoRun.id, {
      outcome: 'cancelled', reason: 'Already merged',
    }), /closed, unmerged/);
    await assert.rejects(complete(), /Final CI has not passed/);
    assert.equal((await request(automatic.path, { token })).status, 'REVIEW');
    closeoutChecksPassed = true;
    await Promise.all([complete(), complete()]);
    assert.equal((await request(automatic.runs, { token }))[0].delivery.pullState, 'merged');
    assert.equal((await request(automatic.path, { token })).status, 'COMPLETED');
    const mergedEvents = (await request(`${automatic.path}/events`, { token }))
      .filter(({ eventType }) => eventType === 'task.delivery_closed');
    assert.equal(mergedEvents.length, 1);
    assert.equal(mergedEvents[0].payload.originalCommitSha, draft.commitSha);
    assert.equal(mergedEvents[0].payload.finalCommitSha, wrong);
    assert.equal(mergedEvents[0].payload.mergeSha, 'e'.repeat(40));
    assert.equal(await hasSyncButton(), false);
    const completedRun = (await request(automatic.runs, { token }))[0];
    assert.equal(completedRun.evidence.filter(entry => entry.check).length, 3);
    assert.equal(completedRun.delivery.commitSha, draft.commitSha);
    assert.equal(completedRun.review.decision, 'approved');

    const abandoned = await newTask('ABANDONED-PR');
    const abandonedRun = await request(abandoned.runs, { token, method: 'POST', status: 201 });
    assert.equal((await worker.send('WORKER_CLAIM')).id, abandonedRun.id);
    const reportAbandoned = (sequence, kind, payload) => worker.send('EXECUTION_EVENT', { runId: abandonedRun.id, sequence, kind, payload });
    assert.equal((await reportAbandoned(1, 'thread', { threadId: 'closed-pr-fixture' })).accepted, true);
    assert.equal((await reportAbandoned(2, 'result', candidate(1, repairedHash))).accepted, true);
    await upload(abandonedRun.id, approved, patchBytes, 200);
    assert.equal((await reportAbandoned(3, 'verification', { ...passing, attempt: 1 })).accepted, true);
    await request(`${abandoned.runs}/${abandonedRun.id}/review`, approve);
    let abandonedDelivery;
    for (let attempt = 0; attempt < 60; attempt++) {
      abandonedDelivery = (await request(abandoned.runs, { token }))[0].delivery;
      if (abandonedDelivery?.state === 'published' || abandonedDelivery?.state === 'failed') break;
      await delay(250);
    }
    assert.equal(abandonedDelivery?.state, 'published');
    assert.equal(abandonedDelivery.pullNumber, 3);
    const cancel = (reason) => publisher.closeOut(actor, first.id, abandoned.id, abandonedRun.id, { outcome: 'cancelled', reason });
    await assert.rejects(cancel('  '), /Invalid cancellation reason/);
    snapshot = { state: 'open', merged: false, updated_at: '2026-01-02T00:00:00Z', number: 3,
      head: { sha: abandonedDelivery.commitSha, ref: abandonedDelivery.branch, repo: { id: Number.parseInt(suffix, 16) } },
      base: { ref: abandonedDelivery.baseBranch },
    };
    await assert.rejects(cancel('Work superseded'), /closed, unmerged/);
    snapshot = { ...snapshot, state: 'closed' };
    await Promise.all([cancel('Work superseded'), cancel('Work superseded')]);
    const cancelled = await request(abandoned.path, { token });
    assert.equal(cancelled.status, 'CANCELLED');
    assert(cancelled.archivedAt);
    const cancelledRun = (await request(abandoned.runs, { token }))[0];
    assert.equal(cancelledRun.review.decision, 'approved');
    assert.equal(cancelledRun.delivery.pullState, 'closed');
    const cancelledEvents = (await request(`${abandoned.path}/events`, { token })).filter(({ eventType }) => eventType === 'task.delivery_closed');
    assert.equal(cancelledEvents.length, 1);
    assert.equal(cancelledEvents[0].payload.reason, 'Work superseded');
    await request(checksPath, { token, method: 'PATCH', body: { checks: plan, autoDraftPr: false } });
    console.log('Signed GitHub events, deduplication and verified-commit merge tracking passed');
    console.log('Human approval atomically queued an automatic draft PR with verified evidence');
    console.log('Owner delivery closeout preserved approvals and recorded verified merges or closed PRs once');
  }

  await request(checksPath, { token, method: 'PATCH', body: { checks: plan } });
  const exhausted = await newTask('VERIFICATION-EXHAUSTED');
  const lastRun = await request(exhausted.runs, { token, method: 'POST', status: 201 });
  assert.equal((await worker.send('WORKER_CLAIM')).id, lastRun.id);
  const sendLast = (sequence, kind, payload) => worker.send('EXECUTION_EVENT', { runId: lastRun.id, sequence, kind, payload });
  assert.equal((await sendLast(1, 'thread', { threadId: 'exhausted-fixture' })).accepted, true);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal((await sendLast(attempt * 2, 'result', candidate(attempt, initialHash))).accepted, true);
    assert.equal((await sendLast(attempt * 2 + 1, 'verification', { attempt, patchHash: initialHash, checks: check(false) })).accepted, true);
  }
  assert.equal((await request(exhausted.path, { token })).status, 'FAILED');
  await request(`${exhausted.runs}/${lastRun.id}/review`, { ...approve, status: 409 });
  const rejected = await newTask('REVIEW-REJECTED');
  const rejectedRun = await request(rejected.runs, { token, method: 'POST', status: 201 });
  assert.equal((await worker.send('WORKER_CLAIM')).id, rejectedRun.id);
  for (const [sequence, kind, payload] of [[1, 'thread', { threadId: 'rejected-fixture' }],
    [2, 'result', candidate(1, repairedHash)]]) {
    assert.equal((await worker.send('EXECUTION_EVENT', { runId: rejectedRun.id, sequence, kind, payload })).accepted, true);
  }
  await upload(rejectedRun.id, approved, patchBytes, 200);
  assert.equal((await worker.send('EXECUTION_EVENT', { runId: rejectedRun.id, sequence: 3, kind: 'verification',
    payload: { attempt: 1, patchHash: repairedHash, checks: check(true) } })).accepted, true);
  const evidencePath = `${rejected.runs}/${rejectedRun.id}/evidence`;
  const reviewEvidence = { patchHash: repairedHash, summary: 'Chromium desktop verified', url: 'https://example.test/proof' };
  await request(evidencePath, { token, method: 'POST', body: { ...reviewEvidence, url: 'javascript:alert(1)' }, status: 400 });
  await request(evidencePath, { token, method: 'POST', body: { ...reviewEvidence, patchHash: initialHash }, status: 409 });
  const savedEvidence = await request(evidencePath, { token, method: 'POST', body: reviewEvidence, status: 201 });
  assert.equal(savedEvidence.patchHash, repairedHash);
  assert.equal(savedEvidence.url, reviewEvidence.url);
  const rejectionPath = `${rejected.runs}/${rejectedRun.id}/review`;
  await request(rejectionPath, { token, method: 'POST', body: { decision: 'rejected' }, status: 400 });
  await request(rejectionPath, { token, method: 'POST', body: { decision: 'rejected', comment: 'Needs product review' } });
  assert.equal((await request(rejected.path, { token })).status, 'REJECTED');
  assert.equal((await request(rejected.runs, { token }))[0].delivery, null);
  await request(rejected.runs, { token, method: 'POST', status: 409 });
  await request(rejected.runs, { token, method: 'POST', body: { revisionOf: lastRun.id }, status: 409 });
  const revision = { token, method: 'POST', body: { revisionOf: rejectedRun.id }, status: 201 };
  await request(rejected.runs, { ...revision, status: 409 });
  assert.equal((await request(rejected.path, { token })).status, 'REJECTED');
  await worker.close();
  worker = await open(approved, true, true, true, false, true);
  const legacy = await open(nodeCredential, true, true, true);
  await request(rejected.runs, { ...revision, body: { ...revision.body, workerId: nodeCredential.workerId }, status: 409 });
  const revisionUrl = (id) => new URL(`/worker-executions/${id}/revision-artifact`, workerApi);
  const authorization = (credential) => `Bearer ${credential.workerId}.${credential.token}`;
  const deniedRevision = async (id, status, credential) => {
    const response = await globalThis.fetch(revisionUrl(id), {
      headers: credential ? { Authorization: authorization(credential) } : {},
      signal: globalThis.AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('X-ADO-Base-Commit'), null);
    await response.body?.cancel();
  };
  const expiring = await request(rejected.runs, revision);
  await deniedRevision(expiring.id, 401);
  await deniedRevision(expiring.id, 404, approved);
  assert.equal(await legacy.send('WORKER_CLAIM'), null);
  assert.equal((await worker.send('WORKER_CLAIM')).id, expiring.id);
  await db.query("UPDATE execution_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [expiring.id]);
  await deniedRevision(expiring.id, 404, approved);
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await request(rejected.path, { token })).status === 'TIMEOUT') break;
    await delay(250);
  }
  assert.equal((await request(rejected.path, { token })).status, 'TIMEOUT');
  const revised = await request(rejected.runs, { token, method: 'POST', status: 201 });
  assert.notEqual(revised.id, rejectedRun.id);
  assert.deepEqual(revised.revision, { runId: rejectedRun.id, patchHash: repairedHash, reason: 'Needs product review' });
  assert.equal((await request(rejected.path, { token })).status, 'QUEUED');
  const revisedOffer = await worker.send('WORKER_CLAIM');
  assert.equal(revisedOffer.id, revised.id);
  assert.equal(revisedOffer.taskId, rejected.path.split('/').at(-1));
  assert.deepEqual(revisedOffer.development.revision, revised.revision);
  await deniedRevision(rejectedRun.id, 404, approved);
  await deniedRevision(revised.id, 404, nodeCredential);
  await deniedRevision(revised.id, 404, foreignCredential);
  await deniedRevision(revised.id, 404, { ...approved, token: randomBytes(32).toString('hex') });
  await db.query('DELETE FROM worker_projects WHERE worker_id = $1 AND project_id = $2', [approved.workerId, first.id]);
  await deniedRevision(revised.id, 404, approved);
  await db.query('INSERT INTO worker_projects (worker_id, project_id) VALUES ($1, $2)', [approved.workerId, first.id]);
  const setRevisionHash = (hash) => db.query(
    `UPDATE execution_runs SET developer_assignment = jsonb_set(developer_assignment, '{revision,patchHash}', to_jsonb($2::text))
     WHERE id = $1`, [revised.id, hash]);
  await setRevisionHash(initialHash);
  await deniedRevision(revised.id, 404, approved);
  await setRevisionHash(repairedHash);
  const { rows: [artifact] } = await db.query('SELECT object_key AS key, sha256, size FROM execution_artifacts WHERE run_id = $1', [rejectedRun.id]);
  const setArtifactKey = (key) => db.query('UPDATE execution_artifacts SET object_key = $2 WHERE run_id = $1', [rejectedRun.id, key]);
  await setArtifactKey(`${artifact.key}.missing`);
  await deniedRevision(revised.id, 503, approved);
  await setArtifactKey(artifact.key);
  const store = new ArtifactStore();
  await store.put(artifact, Buffer.alloc(artifact.size, 120));
  try {
    await deniedRevision(revised.id, 503, approved);
  } finally {
    await store.put(artifact, patchBytes);
  }
  const revisionSource = await fetchRevisionArtifact(revisionUrl(revised.id), authorization(approved), globalThis.AbortSignal.timeout(10_000));
  assert.equal(revisionSource.baseCommit, baseline);
  assert.deepEqual(revisionSource.bytes, patchBytes);
  const revisionWorktree = join(workerJournal, 'revision-checkout');
  git('worktree', 'add', '--detach', '--', revisionWorktree, baseline);
  const revisionGit = async (args) => ({ stdout: git('-C', revisionWorktree, ...args) });
  await assert.rejects(restoreRevision(revisionSource, '1'.repeat(40), repairedHash, workerJournal, revisionGit), /expected base or digest/);
  await assert.rejects(restoreRevision(revisionSource, baseline, initialHash, workerJournal, revisionGit), /expected base or digest/);
  assert.equal(readFileSync(join(revisionWorktree, 'index.ts'), 'utf8'), 'old\n');
  await restoreRevision(revisionSource, baseline, repairedHash, workerJournal, revisionGit);
  assert.equal(git('-C', revisionWorktree, 'rev-parse', 'HEAD').trim(), baseline);
  assert.equal(readFileSync(join(revisionWorktree, 'index.ts'), 'utf8'), 'new\n');
  const revisedBytes = Buffer.from(patchBytes.toString().replace('+new\n', '+revised\n'));
  const revisedHash = createHash('sha256').update(revisedBytes).digest('hex');
  const sendRevised = (sequence, kind, payload) => worker.send('EXECUTION_EVENT', { runId: revised.id, sequence, kind, payload });
  const audit = { stage: 'revision', previousRunId: rejectedRun.id, patchHash: repairedHash, outcome: 'applied' };
  assert.equal((await sendRevised(1, 'progress', { ...audit, patchHash: initialHash })).accepted, false);
  assert.equal((await sendRevised(1, 'progress', { ...audit, bytes: 'must not be persisted' })).accepted, true);
  assert.equal((await sendRevised(2, 'thread', { threadId: 'revised-fixture' })).accepted, true);
  assert.equal((await sendRevised(3, 'result', candidate(1, revisedHash))).accepted, true);
  await upload(revised.id, approved, revisedBytes, 200);
  assert.equal((await sendRevised(4, 'verification', { attempt: 1, patchHash: revisedHash, checks: check(true) })).accepted, true);
  const [firstRevisionEvent] = await request(`${rejected.runs}/${revised.id}/events`, { token });
  assert.deepEqual(firstRevisionEvent.payload, audit);
  await deniedRevision(revised.id, 404, approved);
  const [newRun, timedOutRevision, oldRun] = await request(rejected.runs, { token });
  assert.equal(timedOutRevision.id, expiring.id);
  assert.equal(timedOutRevision.status, 'timed_out');
  assert.equal(newRun.review, null);
  assert.deepEqual(newRun.evidence, []);
  assert.deepEqual(oldRun.evidence, [savedEvidence]);
  await request(rejectionPath, { ...approve, status: 404 });
  await request(`${rejected.runs}/${rejectedRun.id}/delivery`, { token, method: 'POST', status: 409 });
  await request(evidencePath, { token, method: 'POST', body: reviewEvidence, status: 404 });
  await request(`${rejected.runs}/${revised.id}/evidence`, { token, method: 'POST', body: { ...reviewEvidence, patchHash: revisedHash }, status: 201 });
  assert.equal((await request(`${rejected.runs}/${revised.id}/review`, approve)).decision, 'approved');
  assert.equal((await request(rejected.runs, { token })).find(({ id }) => id === rejectedRun.id).review.decision, 'rejected');

  await request(checksPath, { token, method: 'PATCH',
    body: { checks: plan, autoDraftPr: false, independentChecks: [{ name: 'browser', kind: 'browser' }] } });
  const sameHash = await newTask('QUALITY-SAME-HASH');
  const oldSameHash = await request(sameHash.runs, { token, method: 'POST', status: 201 });
  const archived = async (run, previous) => {
    assert.equal((await worker.send('WORKER_CLAIM')).id, run.id);
    let sequence = 0;
    const send = (kind, payload) => worker.send('EXECUTION_EVENT', { runId: run.id, sequence: ++sequence, kind, payload });
    if (previous) assert.equal((await send('progress', {
      stage: 'revision', previousRunId: previous.id, patchHash: repairedHash, outcome: 'applied',
    })).accepted, true);
    assert.equal((await send('thread', { threadId: 'same-hash-fixture' })).accepted, true);
    assert.equal((await send('result', candidate(1, repairedHash))).accepted, true);
    await upload(run.id, approved, patchBytes, 200);
    assert.equal((await send('verification', { ...passing, attempt: 1 })).accepted, true);
  };
  await archived(oldSameHash);
  const structured = { patchHash: repairedHash, summary: 'Browser check on frozen archive',
    check: { name: 'browser', status: 'passed', source: 'archive', environment: 'Synthetic browser' } };
  const recordEvidence = (run, status = 201, body = structured) =>
    request(`${sameHash.runs}/${run.id}/evidence`, { token, method: 'POST', status, body });
  await recordEvidence(oldSameHash);
  await request(`${sameHash.runs}/${oldSameHash.id}/review`, {
    token, method: 'POST', body: { decision: 'rejected', comment: 'Request another verification run' },
  });
  const newSameHash = await request(sameHash.runs, { token, method: 'POST', status: 201, body: { revisionOf: oldSameHash.id } });
  await archived(newSameHash, oldSameHash);
  await recordEvidence(oldSameHash, 404);
  await recordEvidence(newSameHash, 409, { ...structured, patchHash: initialHash });
  await request(`/projects/${second.id}/tasks/${sameHash.id}/executions/${newSameHash.id}/evidence`, {
    token, method: 'POST', status: 404, body: structured,
  });
  const sameHashReview = `${sameHash.runs}/${newSameHash.id}/review`;
  await request(sameHashReview, { ...approve, status: 409 });
  const [priorFree, priorArchived] = await request(sameHash.runs, { token });
  assert.equal(priorFree.artifact.sha256, priorArchived.artifact.sha256);
  assert.deepEqual(priorFree.evidence, []);
  assert.equal(priorArchived.evidence.length, 1);
  if (publisher) {
    const actor = await request('/auth/session', { token });
    // Simulate a review left by an older server during a rollback.
    await db.query(
      "INSERT INTO execution_reviews (run_id, reviewer_id, reviewer_name, decision, comment) VALUES ($1,$2,$3,'approved','Fixture')",
      [newSameHash.id, actor.id, actor.name],
    );
    await assert.rejects(publisher.enqueue(actor, first.id, sameHash.id, newSameHash.id), /Required verification is incomplete/);
    await db.query(
      `INSERT INTO execution_deliveries (run_id, repository_id, requested_by, patch_hash, base_commit, base_branch, branch, state)
       VALUES ($1,$2,$3,$4,$5,'main',$6,'queued')`,
      [newSameHash.id, repository.id, actor.id, repairedHash, baseline, `ado/${newSameHash.id}`],
    );
    let delivery;
    for (let attempt = 0; attempt < 30; attempt++) {
      delivery = (await request(sameHash.runs, { token }))[0].delivery;
      if (delivery.state === 'failed') break;
      await delay(250);
    }
    assert.equal(delivery?.state, 'failed');
    assert.equal(delivery?.error, 'quality_gate');
    assert.equal(delivery?.pullNumber, null);
    assert.throws(() => git('rev-parse', '--verify', `ado/${newSameHash.id}`));
    await db.query('DELETE FROM execution_deliveries WHERE run_id = $1', [newSameHash.id]);
    await db.query('DELETE FROM execution_reviews WHERE run_id = $1', [newSameHash.id]);
  }
  const [recorded, racingApproval] = await Promise.all([recordEvidence(newSameHash), globalThis.fetch(new URL(sameHashReview, api), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(approve.body), signal: globalThis.AbortSignal.timeout(10000),
  })]);
  assert.equal(recorded.check.status, 'passed');
  assert([200, 409].includes(racingApproval.status));
  if (racingApproval.status === 409) assert.equal((await racingApproval.json()).code, 'quality_gate');
  else assert.equal((await racingApproval.json()).decision, 'approved');
  await request(sameHashReview, approve);
  assert.equal((await request(sameHash.runs, { token }))[0].delivery, null);
  const beforeEnable = await newTask('AUTO-BEFORE-ENABLE');
  await setAutoApproval(true, false);
  const automaticDispatch = await newTask('AUTO-READY');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await request(automaticDispatch.path, { token })).status === 'QUEUED') break;
    await delay(250);
  }
  assert.equal((await request(automaticDispatch.path, { token })).status, 'QUEUED');
  assert.equal((await request(automaticDispatch.runs, { token })).length, 1);
  const autoEvents = (await request(`${automaticDispatch.path}/events`, { token }))
    .filter(({ eventType }) => eventType === 'task.auto_approval_succeeded');
  assert.equal(autoEvents.length, 1);
  assert.equal(autoEvents[0].payload.from, 'READY');
  assert.equal(autoEvents[0].payload.to, 'QUEUED');
  assert.equal((await request(beforeEnable.path, { token })).status, 'READY');
  assert.equal((await request(beforeEnable.runs, { token })).length, 0);
  await setAutoApproval(false, false);
  await request(beforeEnable.runs, { token, method: 'POST', body: {}, status: 201 });
  await request(automaticDispatch.runs, { token, method: 'POST', body: {}, status: 409 });

  console.log('Independent evidence is frozen per run, gates approval and delivery, and supports audited retests');
  console.log('Rejected candidate revisions, patch-specific evidence and fresh approval passed');
  console.log('Revision artifact access, legacy Worker rejection, integrity, base, and audit checks passed');
  console.log('Workbench dispatch, Worker isolation, event replay, cancellation, timeout and retry passed');
  console.log('Manual approvals pin developer Agent versions and migrated tasks get a default assignment');
  console.log('Worker restart, lost acknowledgement replay and checkpoint recovery passed');
  console.log('Worker assignment isolation, reassignment and structured check diagnostics passed');
  console.log('Resource heartbeats pause new claims and preserve active Worker leases');
  console.log('Repository check snapshots, repair limits, patch-linked reports and human approval passed');
  console.log('Patch archive integrity, download and publication gates passed');
} finally {
  for (const socket of sockets) socket.terminate();
  publisher?.onModuleDestroy();
  await publisherDb?.pool.end();
  if (fixtureRepo) rmSync(fixtureRepo, { recursive: true, force: true });
  if (workerJournal) rmSync(workerJournal, { recursive: true, force: true });
  await db.end();
}
