import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';

const api = new URL(process.env.ADO_VERIFY_API_URL ?? 'http://127.0.0.1:3101');
const { ADO_BOOTSTRAP_EMAIL: email, ADO_BOOTSTRAP_PASSWORD: password } = process.env;
assert(email && password, 'Configure a bootstrap account for the integration check');

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

async function until(fn, description, seconds = 12) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(200);
  }
  assert.fail(description);
}

const { token: admin } = await request('/auth/session', { method: 'POST', body: { email, password } });
const suffix = randomBytes(4).toString('hex');
const project = (code) => request('/projects', {
  token: admin, method: 'POST', body: { code: `${code}-${suffix}`, name: code }, status: 201,
});
const first = await project('WORKERS');
const second = await project('ISOLATED');
const collection = `/projects/${first.id}/workers`;
const secondPath = `/projects/${second.id}/workers`;
const credential = await request(collection, { token: admin, method: 'POST', body: { name: 'Integration Worker' }, status: 201 });
const lookup = async () => {
  const [report] = await request(collection, { token: admin });
  return report;
};
assert.equal((await lookup()).status, 'unregistered');
assert.deepEqual(await request(secondPath, { token: admin }), []);
await request(`${secondPath}/${credential.workerId}/credential`, { token: admin, method: 'POST', status: 404 });

const sessions = new Set();
const proxy = createServer((inbound) => {
  const outbound = createConnection({ host: api.hostname, port: Number(api.port) });
  sessions.add(inbound);
  inbound.on('error', () => outbound.destroy());
  outbound.on('error', () => inbound.destroy());
  inbound.on('close', () => { sessions.delete(inbound); outbound.destroy(); });
  outbound.on('close', () => inbound.destroy());
  inbound.pipe(outbound).pipe(inbound);
});
proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');

const agentSource = fileURLToPath(new URL('../apps/worker/src/main.ts', import.meta.url));
const agents = new Set();
function run(issued) {
  const env = { ...process.env };
  delete env.ADO_BOOTSTRAP_PASSWORD;
  const child = spawn(process.execPath, ['--import', 'tsx', agentSource], {
    env: {
      ...env,
      API_BASE_URL: `http://127.0.0.1:${proxy.address().port}`,
      ADO_WORKER_ID: issued.workerId,
      ADO_WORKER_TOKEN: issued.token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  agents.add(child);
  let registrations = 0;
  let remaining = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    remaining += data;
    const lines = remaining.split('\n');
    remaining = lines.pop();
    registrations += lines.filter((line) => line.includes('"event":"registered"')).length;
  });
  child.stderr.resume();
  const exited = once(child, 'exit').then(([code]) => code);
  child.once('exit', () => agents.delete(child));
  return { exited, registrations: () => registrations };
}

function awaitExit(agent) {
  return Promise.race([agent.exited, delay(12_000, null, { ref: false })]);
}

try {
  const agent = run(credential);
  await until(() => agent.registrations() === 1, 'Worker did not register');
  const before = await lookup();
  assert.equal(before.status, 'online');
  assert.equal(before.capabilities.os, process.platform);
  assert(before.capabilities.cpuCount > 0);
  assert(before.capabilities.diskFreeBytes >= 0);
  assert(before.capabilities.memoryFreeBytes >= 0);
  assert.equal(before.capabilities.minFreeDiskBytes, 0);
  assert.equal(before.capabilities.nodeVersion, process.version);
  assert(!JSON.stringify(before).includes(credential.token));

  await until(async () => (await lookup()).lastHeartbeatAt > before.lastHeartbeatAt,
    'Worker heartbeat did not update', 22);
  for (const connection of sessions) connection.destroy();
  await until(() => agent.registrations() === 2, 'Worker did not reconnect');
  assert.equal((await lookup()).status, 'online');

  await request(`${secondPath}/${credential.workerId}`, { token: admin, method: 'PUT', status: 204 });
  const [alsoGranted] = await request(secondPath, { token: admin });
  assert.equal(alsoGranted.id, credential.workerId);
  await request(`${secondPath}/${credential.workerId}`, { token: admin, method: 'DELETE', status: 204 });
  assert.deepEqual(await request(secondPath, { token: admin }), []);

  const renewed = await request(`${collection}/${credential.workerId}/credential`, { token: admin, method: 'POST' });
  assert.notEqual(renewed.token, credential.token);
  assert.equal((await lookup()).status, 'disconnected');
  for (const connection of sessions) connection.destroy();
  assert.equal(await awaitExit(agent), 1);
  const next = run(renewed);
  await until(() => next.registrations() === 1, 'Rotated Worker credential did not register');
  await request(`${collection}/${credential.workerId}/disable`, { token: admin, method: 'POST', status: 204 });
  for (const connection of sessions) connection.destroy();
  assert.equal(await awaitExit(next), 1);
  assert.equal((await lookup()).status, 'disabled');
  console.log(`Worker registration, heartbeat, reconnect, project access, rotation and disable passed on ${process.platform}`);
} finally {
  for (const child of agents) child.kill();
  for (const connection of sessions) connection.destroy();
  await new Promise((resolve) => proxy.close(resolve));
}
