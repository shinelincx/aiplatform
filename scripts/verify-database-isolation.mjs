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

async function verifyBudgets(ado, fit, third) {
  const month = '2040-11';
  const model = 'fixture-budget-model';
  const source = 'https://example.test/rates';
  const operations = (project, selected = month, actor = token) =>
    request(project.path + '/operations?month=' + selected, { actor });
  const budget = (project, amountUsd, expected = 200, actor = token) =>
    request(project.path + '/operations/budget/' + month, { method: 'PUT', body: { amountUsd }, expected, actor });

  assert.deepEqual((await operations(ado)).monthly,
    { month, budgetUsd: null, estimatedUsd: null, records: 0, matched: 0, undated: 0, notice: 'unset' });
  await budget(ado, '0', 400);
  await budget(ado, '10.001', 400);
  await request(ado.path + '/operations?month=2040-13', { expected: 400 });
  assert.deepEqual(await budget(ado, '10'), { month, budgetUsd: '10.00' });
  assert.equal((await operations(ado)).monthly.notice, 'unknown');
  assert.equal((await operations(fit)).monthly.budgetUsd, null);
  assert.equal((await operations(third, month, viewerToken)).rates, null);
  await budget(third, '25', 403, viewerToken);

  await db.projectTransaction(ado.projectId, async (client) => {
    await client.query('INSERT INTO project_model_rates(project_id,model,input_usd,cached_input_usd,output_usd) VALUES ($1,$2,1000,0,0)',
      [ado.projectId, model]);
    await client.query("INSERT INTO project_model_rate_versions VALUES ($1,$2,1,'2040-10-01T00:00:00Z',$3,1000,0,0), " +
      "($1,$2,2,'2040-11-15T00:00:00Z',$3,2000,0,0)", [ado.projectId, model, source]);
  });
  const record = (stamp, tokens, fields = {}) => db.projectQuery(ado.projectId,
    "INSERT INTO task_events(project_id,task_id,event_type,payload,created_at) VALUES ($1,$2,'agent.model_usage',$3,'2040-11-25T00:00:00Z')",
    [ado.projectId, ado.taskId, { role: 'PROJECT_DIRECTOR', usage: {
      model, inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, providerCreatedAt: stamp, serviceTier: 'default', ...fields,
    } }]);
  await record('2040-10-31T23:59:59.500Z', 1000);
  await record('2040-11-01T00:00:00.000Z', 4000);
  await record('2040-11-14T23:59:59.500Z', 4000);
  await record(undefined, 9000);
  await record('2040-11-03T12:00:00.000Z', 9000, { serviceTier: 'priority' });
  await record('2040-11-04T12:00:00.000Z', 'invalid');
  assert.equal((await operations(ado, '2040-10')).monthly.estimatedUsd, '1.000000000000');
  assert.deepEqual((await operations(ado)).monthly,
    { month, budgetUsd: '10.00', estimatedUsd: '8.000000000000', records: 5, matched: 2, undated: 1, notice: 'warning' });
  await record('2040-11-15T00:00:00.000Z', 1000);
  await record('2040-12-01T00:00:00.000Z', 1000);
  const atLimit = (await operations(ado)).monthly;
  assert.equal(atLimit.estimatedUsd, '10.000000000000');
  assert.equal(atLimit.notice, 'reached');
  assert.equal((await operations(ado, '2040-12')).monthly.estimatedUsd, '2.000000000000');
  const version = await request(ado.path + '/operations/rates/' + model, { method: 'PUT', body: {
    inputUsdPerMillion: '3000', cachedInputUsdPerMillion: '0', outputUsdPerMillion: '0', sourceUrl: source,
  } });
  assert.equal(version.version, 3);
  assert.equal(version.sourceUrl, source);
  assert.deepEqual((await operations(ado)).monthly, atLimit);
  assert.equal((await operations(fit)).monthly.estimatedUsd, null);

  await assert.rejects(db.projectQuery(fit.projectId, 'INSERT INTO project_monthly_budgets VALUES ($1,$2,5)',
    [ado.projectId, month + '-01']), { code: '42501' });
  await assert.rejects(db.projectQuery(ado.projectId, 'UPDATE project_model_rate_versions SET input_usd=1'),
    { code: '42501' });
  await budget(ado, null);
  const final = await operations(ado);
  assert.equal(final.monthly.notice, 'unset');
  assert.equal(final.monthly.estimatedUsd, atLimit.estimatedUsd);
  assert.equal(final.audit.filter(({ action }) => action === 'operations.budget_updated').length, 2);
  console.log('Verified UTC budget months, rate versions, unknown usage, 80% and 100% thresholds, and project permissions.');
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
  assert.deepEqual(grants, { role: 'ado_api', protectedTables: 25, ddl: false, migrations: false, truncate: false });
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
  await verifyBudgets(ado, fit, third);
  console.log('Verified 25 RLS tables, restricted role, three project memberships and transaction-local isolation.');
} finally {
  try {
    if (viewerToken) await request('/auth/session', { method: 'DELETE', actor: viewerToken, expected: 204 });
    if (token) await request('/auth/session', { method: 'DELETE', expected: 204 });
  } finally {
    await db.onModuleDestroy();
  }
}
