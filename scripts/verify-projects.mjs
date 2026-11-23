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
  if (status !== 204) return response.json();
}

const suffix = randomBytes(5).toString('hex');
const login = (body, status = 200) => request('/auth/session', { method: 'POST', body, status });
await request('/projects', { status: 401 });
await login({ email, password: 'wrong-password' }, 401);
const { token: admin } = await login({ email, password });
const credentials = { email: `viewer-${suffix}@example.test`, password: randomBytes(24).toString('hex') };
const user = await request('/users', {
  method: 'POST', token: admin, body: { ...credentials, name: 'Integration Viewer', systemRole: 'user' }, status: 201,
});
const { token: viewer } = await login(credentials);
await request('/users', { token: viewer, status: 403 });

const listUsers = () => request('/users', { token: admin });
const initialUsers = await listUsers();
const actor = await request('/auth/session', { token: admin });
const actorPath = `/users/${actor.id}`;
const userPath = `/users/${user.id}`;
const candidateCredentials = { email: `admin-${suffix}@example.test`, password: randomBytes(24).toString('hex') };
const candidateBody = { ...candidateCredentials, name: 'Integration Admin', systemRole: 'admin' };
const editBody = { name: 'Updated Admin', systemRole: 'user' };

for (const [token, status] of [[undefined, 401], [viewer, 403]]) {
  await request('/users', { token, method: 'POST', body: candidateBody, status });
  await request(userPath, { token, method: 'PATCH', body: editBody, status });
  await request(userPath, { token, method: 'DELETE', status });
}
await request('/users', { token: admin, method: 'POST', status: 400,
  body: { ...candidateBody, systemRole: 'owner' } });
await request('/users', { token: admin, method: 'POST', status: 400,
  body: { ...candidateBody, name: ' ' } });
await request(userPath, { token: admin, method: 'PATCH', status: 400, body: { ...editBody, email: 'other@example.test' } });
await request(userPath, { token: admin, method: 'PATCH', status: 400, body: { ...editBody, name: ' ' } });
assert.deepEqual(await listUsers(), initialUsers);

if (initialUsers.filter(({ status, systemRole }) => status === 'active' && systemRole === 'admin').length === 1) {
  const lastAdmin = await request(actorPath, { token: admin, method: 'DELETE', status: 409 });
  assert.equal(lastAdmin.message, 'Cannot remove the last active administrator');
  const demotion = await request(actorPath, { token: admin, method: 'PATCH', status: 409,
    body: { name: actor.name, systemRole: 'user' } });
  assert.equal(demotion.message, 'Cannot remove the last active administrator');
  assert.deepEqual(await listUsers(), initialUsers);
}

const candidate = await request('/users', { token: admin, method: 'POST', body: candidateBody, status: 201 });
assert.equal(candidate.email, candidateCredentials.email);
assert.equal(candidate.name, candidateBody.name);
assert.equal(candidate.systemRole, 'admin');
assert.equal(candidate.password, undefined);
assert.equal(candidate.password_hash, undefined);
assert.deepEqual((await listUsers()).find(({ id }) => id === candidate.id), candidate);
const candidatePath = `/users/${candidate.id}`;
const { token: secondary } = await login(candidateCredentials);
await request('/users', { token: secondary });
const selfDisable = await request(actorPath, { token: admin, method: 'DELETE', status: 409 });
assert.equal(selfDisable.message, 'Cannot disable your own account');

const updated = await request(candidatePath, { token: admin, method: 'PATCH', body: editBody });
assert.deepEqual(updated, { ...candidate, ...editBody });
assert.deepEqual((await listUsers()).find(({ id }) => id === candidate.id), updated);
await request('/users', { token: secondary, status: 403 });
await request(candidatePath, { token: admin, method: 'DELETE', status: 204 });
assert.deepEqual((await listUsers()).find(({ id }) => id === candidate.id), { ...updated, status: 'disabled' });
await request('/auth/session', { token: secondary, status: 401 });
await login(candidateCredentials, 401);

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
assert.match(dashboardHtml, /aria-label="Integration Viewer，打开设置"/);
const settings = (path, session = cookie.split(';')[0]) => globalThis.fetch(new URL(path, web), {
  headers: { Cookie: session },
  redirect: 'manual',
  signal: globalThis.AbortSignal.timeout(30000),
});
const settingsHome = await settings('/settings');
assert.equal(settingsHome.status, 307);
assert.equal(settingsHome.headers.get('location'), '/settings/account');
const profile = await settings('/settings/account');
assert.equal(profile.status, 200);
assert.match(await profile.text(), /修改密码/);
for (const [path, title] of [['projects', '项目目录'], ['accounts', '账号管理']]) {
  const restricted = await settings(`/settings/${path}`);
  assert.equal(restricted.status, 307);
  assert.equal(restricted.headers.get('location'), '/settings/account?issue=forbidden');
  const management = await settings(`/settings/${path}`, `ado_session=${admin}`);
  assert.equal(management.status, 200);
  assert((await management.text()).includes(title));
}

await request(`${fitbestPath}/archive`, { token: admin, method: 'POST', status: 204 });
assert.equal((await request(fitbestPath, { token: viewer })).status, 'archived');
await request(fitbestPath, { token: admin, method: 'PATCH', body: { name: 'Archived' }, status: 409 });
await request('/auth/session', { token: viewer, method: 'DELETE', status: 204 });
await request('/projects', { token: viewer, status: 401 });

const { token: profileSession } = await login(credentials);
const updatePassword = (body, status) => request('/auth/password', {
  token: profileSession, method: 'PATCH', body, status,
});
assert.equal((await request('/auth/profile', {
  token: profileSession, method: 'PATCH', body: { name: 'Renamed Viewer' },
})).name, 'Renamed Viewer');
const newPassword = randomBytes(24).toString('hex');
await updatePassword({ currentPassword: 'wrong-password', newPassword }, 403);
await updatePassword({ currentPassword: credentials.password, newPassword }, 204);
await request('/auth/session', { token: profileSession, status: 401 });
const webToken = cookie.split(';')[0].slice('ado_session='.length);
await request('/auth/session', { token: webToken, status: 401 });
await login(credentials, 401);
await login({ ...credentials, password: newPassword });
console.log('Project isolation, account settings, session revocation, Web login, and task state checks passed');
