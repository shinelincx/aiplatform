import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { Database } from '../apps/api/src/database.ts';

const db = new Database();
const api = process.env.ADO_VERIFY_API_URL ?? 'http://127.0.0.1:3101';
const suffix = randomBytes(5).toString('hex');
let token;
let viewerToken;

async function request(path, { method = 'GET', body, expected = 200, actor = token } = {}) {
  const response = await globalThis.fetch(api + path, {
    method, headers: { ...(actor && { Authorization: 'Bearer ' + actor }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body), signal: globalThis.AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expected, method + ' ' + path);
  if (response.ok && expected !== 204) return response.json();
}

async function post(path, body, expected = 201) {
  return request(path, { method: 'POST', body, expected });
}

async function seed(name, index) {
  const code = name + '-' + suffix;
  const { id: projectId } = await post('/projects', { code, name });
  const path = '/projects/' + projectId;
  const task = await post(path + '/tasks', { code: 'CHECK', title: name, description: 'Synthetic isolation fixture',
    priority: 'P1', acceptanceCriteria: ['Retain the project scope'] });
  const runId = await db.projectTransaction(projectId, async (client) => {
    const { rows: [repo] } = await client.query(
      `INSERT INTO repositories(project_id,github_repository_id,owner,repo_name,repository_url,default_branch,installation_id)
       VALUES ($1,$2,'fixture',$3,$4,'main',1) RETURNING id`,
      [projectId, Number.parseInt(suffix, 16) + index, code, 'https://github.com/fixture/' + code]);
    const { rows: [run] } = await client.query(
      "INSERT INTO execution_runs(project_id,task_id,repository_id,status) VALUES ($1,$2,$3,'succeeded') RETURNING id",
      [projectId, task.id, repo.id]);
    await client.query("INSERT INTO execution_events(run_id,sequence,kind,payload) VALUES ($1,1,'thread','{}')", [run.id]);
    return run.id;
  });
  return { projectId, taskId: task.id, runId, path };
}

try {
  await db.onModuleInit();
  const { rows: [grants] } = await db.pool.query(`
    SELECT current_user AS role,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity) AS "protectedTables",
      has_schema_privilege('public', 'CREATE') AS ddl,
      has_table_privilege('schema_migrations', 'INSERT') AS migrations,
      has_table_privilege('tasks', 'TRUNCATE') AS truncate
  `);
  assert.deepEqual(grants, { role: 'ado_api', protectedTables: 23, ddl: false, migrations: false, truncate: false });
  const email = process.env.ADO_BOOTSTRAP_EMAIL;
  const password = process.env.ADO_BOOTSTRAP_PASSWORD;
  assert(email && password, 'Use an isolated stack with a synthetic bootstrap account');
  ({ token } = await post('/auth/session', { email, password }, 200));
  const ado = await seed('ADO-ISOLATION', 1);
  const fit = await seed('FITBEST-ISOLATION', 2);
  const third = await seed('THIRD-ISOLATION', 3);
  const viewerEmail = 'viewer-' + suffix + '@example.test';
  const viewer = await post('/users', { email: viewerEmail, name: 'Isolated viewer', password });
  await request(third.path + '/members/' + viewer.id, { method: 'PUT', body: { role: 'viewer' }, expected: 204 });
  ({ token: viewerToken } = await post('/auth/session', { email: viewerEmail, password }, 200));
  assert.deepEqual((await request('/projects', { actor: viewerToken })).map(({ id }) => id), [third.projectId]);
  await request(ado.path + '/tasks', { actor: viewerToken, expected: 404 });
  await request(fit.path + '/operations', { actor: viewerToken, expected: 404 });
  assert.deepEqual((await request(third.path + '/tasks', { actor: viewerToken })).map(({ id }) => id), [third.taskId]);

  const pooled = await db.pool.connect();
  try {
    const { rows: [connection] } = await pooled.query('SELECT pg_backend_pid() AS pid');
    const visible = async () => {
      const { rows: [state] } = await pooled.query(`
        SELECT pg_backend_pid() AS pid, ARRAY(SELECT id FROM projects ORDER BY id) AS projects,
          ARRAY(SELECT id FROM tasks ORDER BY id) AS tasks, ARRAY(SELECT run_id FROM execution_events ORDER BY run_id) AS events
      `);
      return state;
    };
    const hidden = { pid: connection.pid, projects: [], tasks: [], events: [] };
    assert.deepEqual(await visible(), hidden);
    await pooled.query('BEGIN');
    await db.bindProject(pooled, ado.projectId);
    await assert.rejects(db.bindProject(pooled, fit.projectId), /Project scope cannot change/);
    assert.deepEqual(await visible(), { pid: connection.pid, projects: [ado.projectId], tasks: [ado.taskId], events: [ado.runId] });
    assert.equal((await pooled.query("UPDATE tasks SET title='not visible' WHERE id=$1", [fit.taskId])).rowCount, 0);
    await pooled.query('SAVEPOINT wrong_event');
    await assert.rejects(pooled.query("INSERT INTO execution_events(run_id,sequence,kind,payload) VALUES ($1,2,'thread','{}')",
      [third.runId]), { code: '42501' });
    await pooled.query('ROLLBACK TO SAVEPOINT wrong_event');
    await pooled.query('COMMIT');
    assert.deepEqual(await visible(), hidden);
    await pooled.query('BEGIN');
    await db.bindProject(pooled, fit.projectId);
    assert.deepEqual(await visible(), { pid: connection.pid, projects: [fit.projectId], tasks: [fit.taskId], events: [fit.runId] });
    await pooled.query('ROLLBACK');
    assert.deepEqual(await visible(), hidden);
    await pooled.query('BEGIN');
    await db.bindProject(pooled, 'invalid-fixture-project');
    assert.deepEqual(await visible(), hidden);
    await pooled.query('ROLLBACK');
  } finally {
    const broken = await pooled.query('ROLLBACK').then(() => false, () => true);
    pooled.release(broken);
  }
  console.log('Verified 23 RLS tables, restricted role, three project memberships and transaction-local isolation.');
} finally {
  try {
    if (viewerToken) await request('/auth/session', { method: 'DELETE', actor: viewerToken, expected: 204 });
    if (token) await request('/auth/session', { method: 'DELETE', expected: 204 });
  } finally {
    await db.onModuleDestroy();
  }
}
