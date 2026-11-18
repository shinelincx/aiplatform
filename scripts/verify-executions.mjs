import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import pg from 'pg';
import { WebSocket } from 'ws';

const api = new URL(process.env.ADO_VERIFY_API_URL ?? 'http://127.0.0.1:3101');
const web = process.env.ADO_VERIFY_WEB_URL ?? 'http://web:3000';
const email = process.env.ADO_BOOTSTRAP_EMAIL;
const password = process.env.ADO_BOOTSTRAP_PASSWORD;
assert(email && password, 'Configure a bootstrap account for the integration check');
const db = new pg.Pool();
const sockets = new Set();

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

async function open(credential, execute = true) {
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
  const outsider = await open(await credentials(second.id));
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

  const cancelled = await newTask('CANCEL-EXECUTION');
  const secondRun = await request(cancelled.runs, { token, method: 'POST', status: 201 });
  assert.equal((await worker.send('WORKER_CLAIM')).id, secondRun.id);
  await request(`${cancelled.runs}/${secondRun.id}/cancel`, { token, method: 'POST', status: 204 });
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
  console.log('Workbench dispatch, Worker isolation, event replay, cancellation, timeout and retry passed');
} finally {
  for (const socket of sockets) socket.terminate();
  await db.end();
}
