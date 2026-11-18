import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import pg from 'pg';
import { WebSocket } from 'ws';
import { ArtifactStore } from '../apps/api/src/artifacts.ts';
import { AuthService } from '../apps/api/src/auth.ts';
import { Database } from '../apps/api/src/database.ts';
import { DeliveriesService } from '../apps/api/src/deliveries.ts';
import { pushCandidate } from '../apps/api/src/git-delivery.ts';
import { ProjectsService } from '../apps/api/src/projects.ts';
import { TasksService } from '../apps/api/src/tasks.ts';
import { WorkerJobs } from '../apps/worker/src/jobs.ts';

const api = new URL(process.env.ADO_VERIFY_API_URL ?? 'http://127.0.0.1:3101');
const web = process.env.ADO_VERIFY_WEB_URL ?? 'http://web:3000';
const email = process.env.ADO_BOOTSTRAP_EMAIL;
const password = process.env.ADO_BOOTSTRAP_PASSWORD;
assert(email && password, 'Configure a bootstrap account for the integration check');
const db = new pg.Pool();
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

async function open(credential, execute = true, verify = false, archive = false) {
  const endpoint = new URL('/workers/ws', api);
  endpoint.protocol = 'ws:';
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
  const foreignCredential = await credentials(second.id);
  const outsider = await open(foreignCredential);
  const observer = await open(await credentials(first.id), false);

  // Database fixtures establish a repository binding without contacting GitHub in local CI.
  const { rows: [repository] } = await db.query(
    `INSERT INTO repositories (project_id, github_repository_id, owner, repo_name, repository_url, default_branch, installation_id)
     VALUES ($1, $2, 'test', 'execution-fixture', 'https://github.com/test/execution-fixture', 'main', 1)
     RETURNING id`, [first.id, Number.parseInt(suffix, 16)],
  );

  const tasks = `/projects/${first.id}/tasks`;
  const newTask = async (code) => {
    const created = await request(tasks, { token, method: 'POST', status: 201, body: {
      code, title: code, description: 'Exercise the platform execution protocol',
      repositoryId: repository.id, acceptanceCriteria: ['Report tracked file changes'],
    } });
    const base = `${tasks}/${created.id}`;
    for (const status of ['PLANNING', 'WAITING_APPROVAL', 'READY']) {
      await request(`${base}/transition`, { token, method: 'POST', body: { status } });
    }
    return { id: created.id, path: base, runs: `${base}/executions` };
  };
  const task = await newTask('WEB-EXECUTION');
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
  const formHtml = (await rendered.text()).match(/<form[^>]*>(?:(?!<\/form>)[\s\S])*派发任务<\/button><\/form>/)?.[0];
  const action = formHtml?.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
  assert(action, 'Expected approved task dispatch form');
  const dispatch = new globalThis.FormData();
  dispatch.set(action, '');
  dispatch.set('projectId', first.id);
  dispatch.set('taskId', task.id);
  assert.equal((await postForm(selected, dispatch, cookie)).status, 303);
  const [initial] = await request(task.runs, { token });
  assert.equal(initial.status, 'queued');
  await request(task.runs, { token, method: 'POST', status: 409 });
  assert.equal(await outsider.send('WORKER_CLAIM'), null);
  assert.equal(await observer.send('WORKER_CLAIM'), null);

  let worker = await open(approved);
  const offer = await worker.send('WORKER_CLAIM');
  assert.equal(offer.id, initial.id);
  assert.equal(offer.taskId, task.id);
  assert.equal(offer.repository, 'test/execution-fixture');
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
    assert.equal(afterRestart.runId, null);
    assert.equal(restartedExecution, false);
    assert.equal((await request(target.path, { token })).status, complete ? 'TESTING' : 'FAILED');
    assert.deepEqual(await worker.send('WORKER_RECOVER', run.id), { state: 'finished', lastSequence: 3 });
    const restored = await request(`${target.runs}/${run.id}/events`, { token });
    assert.deepEqual(restored.map(({ sequence, kind }) => [sequence, kind]),
      [[1, 'thread'], [2, 'progress'], [3, complete ? 'result' : 'failed']]);
    if (!complete) assert.equal(restored[2].payload.code, 'worker_restarted');
    const savedEvents = JSON.parse(readFileSync(join(workerJournal, `${run.id}.events.json`), 'utf8'));
    assert.equal(savedEvents.events.length, 3);
    assert(!Object.hasOwn(savedEvents, 'repositoryToken'));
  };
  await recoverJob('RECOVER-COMPLETE', true);
  await recoverJob('RECOVER-INTERRUPTED', false);

  const cancelled = await newTask('CANCEL-EXECUTION');
  const secondRun = await request(cancelled.runs, { token, method: 'POST', status: 201 });
  assert.equal((await worker.send('WORKER_CLAIM')).id, secondRun.id);
  await request(`${cancelled.runs}/${secondRun.id}/cancel`, { token, method: 'POST', status: 204 });
  assert.deepEqual(await worker.send('WORKER_RECOVER', secondRun.id), { state: 'cancelling', lastSequence: 0 });
  assert.deepEqual(await worker.send('WORKER_HEARTBEAT', secondRun.id), { stop: true });
  assert.deepEqual(await worker.send('EXECUTION_EVENT', {
    runId: secondRun.id, sequence: 1, kind: 'cancelled', payload: {},
  }), { stop: false, accepted: true });
  assert.equal((await request(cancelled.path, { token })).status, 'CANCELLED');

  const timed = await newTask('TIMEOUT-EXECUTION');
  const timedRun = await request(timed.runs, { token, method: 'POST', status: 201 });
  assert.equal((await worker.send('WORKER_CLAIM')).id, timedRun.id);
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
  git('init', '-q', '-b', 'main');
  writeFileSync(join(fixtureRepo, 'index.ts'), 'old\n');
  git('add', 'index.ts');
  git('-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base');
  const baseline = git('rev-parse', 'HEAD').trim();
  const candidate = (attempt, patchHash) => ({ ...result.payload, baseCommit: baseline, attempt, patchHash });
  const check = (passed) => [{ name: 'unit', durationMs: 20, status: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1 }];
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
    const response = await globalThis.fetch(new URL(`/worker-executions/${runId}/artifact`, api), {
      method: 'PUT', body: bytes,
      headers: { Authorization: `Bearer ${credential.workerId}.${credential.token}`, 'Content-Type': 'application/octet-stream' },
      signal: globalThis.AbortSignal.timeout(12000),
    });
    assert.equal(response.status, expected);
    if (response.ok) assert.deepEqual(await response.json(), { sha256: repairedHash, size: bytes.length });
  };
  await upload(active.id, foreignCredential, patchBytes, 404);
  await upload(active.id, approved, Buffer.from('mismatched bytes'), 409);
  await upload(active.id, approved, patchBytes, 200);
  await upload(active.id, approved, patchBytes, 200);
  assert.equal((await sendEvent(5, 'verification', passing)).accepted, true);
  assert.equal((await sendEvent(5, 'verification', passing)).accepted, true);
  assert.equal((await request(verified.path, { token })).status, 'REVIEW');
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
  const approvalForm = (await pendingReview.text()).match(/<form[^>]*>(?:(?!<\/form>)[\s\S])*批准变更<\/button>(?:(?!<\/form>)[\s\S])*<\/form>/)?.[0];
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
  assert(reportHtml.includes('发布分支并创建草稿 PR'));
  if (!process.env.GITHUB_APP_ID) await request(deliveryPath, { token, method: 'POST', status: 503 });

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (webhookSecret) {
    const branch = `ado/${active.id}`;
    publisherDb = new Database();
    const projects = new ProjectsService(publisherDb, new AuthService(publisherDb));
    let pullCalls = 0;
    const github = {
      configured: true,
      async deliveryToken(install, repo) {
        assert.equal(install, 1);
        assert.equal(repo, Number.parseInt(suffix, 16));
        return 'release-fixture-token';
      },
      async draftPull(credential, repositoryName, head, base, commit) {
        assert.equal(credential, 'release-fixture-token');
        assert.equal(repositoryName, 'test/execution-fixture');
        assert.equal(head, branch);
        assert.equal(base, 'main');
        assert.equal(git('rev-parse', branch).trim(), commit);
        assert.equal(git('show', `${commit}:index.ts`), 'new\n');
        pullCalls++;
        return { number: 1, url: 'https://github.com/test/execution-fixture/pull/1',
          updatedAt: '2026-01-01T00:00:00Z', state: 'open' };
      },
    };
    publisher = new DeliveriesService(publisherDb, new TasksService(publisherDb, projects), projects,
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
    console.log('Signed GitHub events, deduplication and verified-commit merge tracking passed');
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
  const rejectionPath = `${rejected.runs}/${rejectedRun.id}/review`;
  await request(rejectionPath, { token, method: 'POST', body: { decision: 'rejected' }, status: 400 });
  await request(rejectionPath, { token, method: 'POST', body: { decision: 'rejected', comment: 'Needs product review' } });
  assert.equal((await request(rejected.path, { token })).status, 'REJECTED');
  console.log('Workbench dispatch, Worker isolation, event replay, cancellation, timeout and retry passed');
  console.log('Worker restart, lost acknowledgement replay and checkpoint recovery passed');
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
