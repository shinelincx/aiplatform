import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { URL } from 'node:url';

const api = process.env.ADO_VERIFY_API_URL ?? 'http://127.0.0.1:3101';
const web = process.env.ADO_VERIFY_WEB_URL ?? 'http://127.0.0.1:3100';
const email = process.env.ADO_BOOTSTRAP_EMAIL;
const password = process.env.ADO_BOOTSTRAP_PASSWORD;
assert(email && password, 'Configure a bootstrap account for the integration check');

async function request(path, { method = 'GET', token, body, status = 200 } = {}) {
  const response = await globalThis.fetch(new URL(path, api), {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: globalThis.AbortSignal.timeout(10000),
  });
  assert.equal(response.status, status, `${method} ${path} returned ${response.status}`);
  if (status < 300 && status !== 204) return response.json();
}

const suffix = randomBytes(5).toString('hex');
const login = (body, status = 200) => request('/auth/session', { method: 'POST', body, status });
await request('/projects', { status: 401 });
await login({ email, password: 'wrong-password' }, 401);
const { token: admin } = await login({ email, password });
const credentials = { email: `viewer-${suffix}@example.test`, password: randomBytes(24).toString('hex') };
const user = await request('/users', {
  method: 'POST', token: admin, body: { ...credentials, name: 'Integration Viewer' }, status: 201,
});
const { token: viewer } = await login(credentials);
await request('/users', { token: viewer, status: 403 });

const project = (code, name) => request('/projects', {
  token: admin, method: 'POST', body: { code: `${code}-${suffix}`, name }, status: 201,
});
const fitbest = await project('FITBEST', 'Fitbest integration');
const ado = await project('ADO', 'ADO integration');
assert.notEqual(fitbest.id, ado.id);
await request('/projects', {
  token: admin, method: 'POST', body: { code: fitbest.code, name: 'Duplicate' }, status: 409,
});

const fitbestPath = `/projects/${fitbest.id}`;
const adoPath = `/projects/${ado.id}`;
await request(`${fitbestPath}/members/${user.id}`, { method: 'PUT', token: admin, body: { role: 'viewer' }, status: 204 });
const onlyVisible = await request('/projects', { token: viewer });
assert.deepEqual(onlyVisible.map(({ id }) => id), [fitbest.id]);
assert.equal((await request(fitbestPath, { token: viewer })).role, 'viewer');
await request(adoPath, { token: viewer, status: 404 });
await request(`${adoPath}/repositories`, { token: viewer, status: 404 });
await request(`${fitbestPath}/repositories/installations`, { token: viewer, status: 403 });
await request(fitbestPath, { token: viewer, method: 'PATCH', body: { name: 'Rejected' }, status: 403 });
assert.deepEqual(await request(`${fitbestPath}/repositories`, { token: viewer }), []);
assert.equal((await request(fitbestPath, {
  token: admin, method: 'PATCH', body: { description: 'Updated by owner' },
})).description, 'Updated by owner');

const createTask = (projectPath, code, links = {}) => request(`${projectPath}/tasks`, {
  token: admin, method: 'POST', status: 201,
  body: { code, title: code, description: 'Integration task', acceptanceCriteria: ['Check test result'], ...links },
});
const prerequisite = await createTask(fitbestPath, 'SMOKE-01');
const blocked = await createTask(fitbestPath, 'SMOKE-02', {
  dependencies: [prerequisite.id], parentTaskId: prerequisite.id,
});
const foreign = await createTask(adoPath, 'SMOKE-03');
const prerequisitePath = `${fitbestPath}/tasks/${prerequisite.id}`;
const blockedPath = `${fitbestPath}/tasks/${blocked.id}`;
await request(prerequisitePath, { token: admin, method: 'PATCH', body: { dependencies: [blocked.id] }, status: 409 });
await request(prerequisitePath, { token: admin, method: 'PATCH', body: { parentTaskId: blocked.id }, status: 409 });
await request(prerequisitePath, { token: admin, method: 'PATCH', body: { dependencies: [foreign.id] }, status: 404 });
await request(`${fitbestPath}/tasks/${foreign.id}`, { token: viewer, status: 404 });
await request(prerequisitePath, { token: viewer, method: 'PATCH', body: { title: 'Rejected' }, status: 403 });
const transition = (path, state, status = 200) => request(`${path}/transition`, {
  token: admin, method: 'POST', body: { status: state }, status,
});
await transition(blockedPath, 'READY', 409);
await transition(blockedPath, 'PLANNING');
await transition(blockedPath, 'WAITING_APPROVAL');
await transition(blockedPath, 'READY', 409);
for (let index = 0; index < 10; index++) {
  await request(prerequisitePath, { token: admin, method: 'PATCH', body: { title: `Prerequisite ${index}` } });
}
await transition(prerequisitePath, 'PLANNING');
await transition(prerequisitePath, 'WAITING_APPROVAL');
assert.equal((await transition(prerequisitePath, 'READY')).status, 'READY');
const events = await request(`${prerequisitePath}/events`, { token: viewer });
assert(events.every((event, index) => index === 0 || BigInt(event.id) > BigInt(events[index - 1].id)));
assert.deepEqual(events.filter(({ eventType }) => eventType !== 'task.updated').map(({ payload }) => payload.to ?? payload.status),
  ['CREATED', 'PLANNING', 'WAITING_APPROVAL', 'READY']);

const home = await globalThis.fetch(web, { signal: globalThis.AbortSignal.timeout(30000) });
assert.equal(home.status, 200);
const html = await home.text();
assert(html.includes('连接正常'));
const action = html.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
assert(action, 'Expected a rendered login form');
const form = new globalThis.FormData();
form.set(action, '');
form.set('email', credentials.email);
form.set('password', credentials.password);
const loginResult = await globalThis.fetch(web, {
  method: 'POST',
  body: form,
  redirect: 'manual',
  headers: { Origin: new URL(web).origin },
  signal: globalThis.AbortSignal.timeout(30000),
});
assert.equal(loginResult.status, 303, 'Expected Web login to redirect');
const cookie = loginResult.headers.get('set-cookie');
assert(cookie?.startsWith('ado_session=') && /HttpOnly/i.test(cookie), 'Expected secure session handling');
if (new URL(web).protocol === 'https:') assert(/;\s*Secure(?:;|$)/i.test(cookie), 'Expected a Secure cookie over HTTPS');
const dashboard = await globalThis.fetch(new URL(`/?project=${ado.id}`, web), {
  headers: { Cookie: cookie.split(';')[0] },
  signal: globalThis.AbortSignal.timeout(30000),
});
assert.equal(dashboard.status, 200);
const dashboardHtml = await dashboard.text();
assert(dashboardHtml.includes('Fitbest integration'));
assert(!dashboardHtml.includes('ADO integration'));

await request(`${fitbestPath}/archive`, { token: admin, method: 'POST', status: 204 });
assert.equal((await request(fitbestPath, { token: viewer })).status, 'archived');
await request(fitbestPath, { token: admin, method: 'PATCH', body: { name: 'Archived' }, status: 409 });
await request('/auth/session', { token: viewer, method: 'DELETE', status: 204 });
await request('/projects', { token: viewer, status: 401 });
console.log('Project isolation, session revocation, Web login, and task state checks passed');
