
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { AuthService } from '../apps/api/src/auth.ts';
import { Database } from '../apps/api/src/database.ts';
import { ProjectsService } from '../apps/api/src/projects.ts';
import { StagingReleasesController } from '../apps/api/src/staging-releases.ts';

const db = new Database();
const auth = new AuthService(db);
const projects = new ProjectsService(db, auth);
const approvals = new StagingReleasesController(db, auth, projects);
const githubFetch = globalThis.fetch;
const gateway = process.env.ADO_VERIFY_WEB_URL;
const gatewaySecret = process.env.ADO_STAGING_RELEASE_SECRET;
const secret = randomBytes(32).toString('hex');
process.env.ADO_STAGING_RELEASE_SECRET = secret;
process.env.ADO_STAGING_WORKFLOW_TOKEN = 'fixture-no-network';
const authorization = 'Bearer ' + secret;
const sha = randomBytes(20).toString('hex');
const baseSha = randomBytes(20).toString('hex');
const image = 'ghcr.io/shinelincx/aiplatform@sha256:' + 'a'.repeat(64);
const release = { sha, baseSha, image, sourceRun: '41', pulls: [25], files: ['apps/api/src/database.ts'] };
let main = sha;
let dispatched = 0;

globalThis.fetch = async (url, options) => {
  if (String(url).endsWith('/git/ref/heads/main')) return globalThis.Response.json({ object: { sha: main } });
  if (String(url).endsWith('/dispatches')) {
    assert.deepEqual(JSON.parse(options.body), { ref: 'main', inputs: { sha: main } });
    dispatched++;
    return new globalThis.Response(null, { status: dispatched === 1 ? 503 : 204 });
  }
  if (String(url).endsWith('/attempts/1/jobs')) return globalThis.Response.json({
    jobs: [{ name: 'deploy', status: 'completed', steps: [{ name: 'Transfer and deploy approved image', conclusion: 'failure' }] }],
  });
  throw new Error('Unexpected fetch in staging approval verification');
};

try {
  const login = await auth.login({ email: process.env.ADO_BOOTSTRAP_EMAIL, password: process.env.ADO_BOOTSTRAP_PASSWORD });
  const administrator = await auth.account('Bearer ' + login.token);
  const memberPassword = randomBytes(20).toString('hex');
  const member = await auth.createUser(administrator, {
    email: 'staging-approval-' + sha.slice(0, 9) + '@example.test', name: 'Ordinary member',
    password: memberPassword, systemRole: 'user',
  });
  const status = (code) => (error) => error.getStatus() === code;
  const pending = (value = sha) => ({ ...release, sha: value });
  const claim = (run) => approvals.claim(authorization, sha, { run, attempt: '1' });
  const stored = async (value = sha) => (await approvals.list(administrator)).releases.find(row => row.sha === value);

  await assert.rejects(approvals.register('Bearer invalid', release), status(401));
  await assert.rejects(approvals.register(authorization, { ...release, files: ['apps/web/app/page.tsx'] }), status(400));
  await approvals.register(authorization, pending());
  await approvals.register(authorization, { ...pending(), sourceRun: '42' });
  assert.equal((await stored()).sourceRun, '41');
  await assert.rejects(db.pool.query('UPDATE staging_releases SET image = $2 WHERE sha = $1', [sha, image]), { code: '42501' });
  await assert.rejects(approvals.list(member), status(403));
  await assert.rejects(approvals.decide(member, sha, { decision: 'approved' }), status(403));
  await assert.rejects(claim('51'), status(409));

  const rejected = randomBytes(20).toString('hex');
  await approvals.register(authorization, pending(rejected));
  await assert.rejects(approvals.decide(administrator, rejected, { decision: 'rejected' }), status(400));
  await approvals.decide(administrator, rejected, { decision: 'rejected', note: 'Maintain the current version' });
  assert.equal((await stored(rejected)).state, 'rejected');
  await assert.rejects(approvals.decide(administrator, rejected, { decision: 'approved' }), status(409));

  main = baseSha;
  await assert.rejects(approvals.decide(administrator, sha, { decision: 'approved' }), status(409));
  main = sha;
  const decisions = await Promise.allSettled([
    approvals.decide(administrator, sha, { decision: 'approved', note: 'Window verified' }),
    approvals.decide(administrator, sha, { decision: 'approved', note: 'Window verified' }),
  ]);
  assert.equal(decisions.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(dispatched, 1);
  assert.equal((await stored()).state, 'approved');
  assert.equal(decisions.find(item => item.status === 'fulfilled').value.dispatched, false);
  assert.deepEqual(await approvals.decide(administrator, sha, { decision: 'retry' }), { dispatched: true });

  const claims = await Promise.allSettled([claim('51'), claim('52')]);
  assert.equal(claims.filter(item => item.status === 'fulfilled').length, 1);
  const run = claims[0].status === 'fulfilled' ? '51' : '52';
  assert.deepEqual(claims.find(item => item.status === 'fulfilled').value, { image, baseSha });
  await assert.rejects(approvals.result(authorization, sha, { run, attempt: '2', state: 'succeeded' }), status(409));
  const verified = await stored();
  assert.equal(verified.state, 'failed');
  assert.equal(verified.decidedBy, administrator.name);
  assert.equal(verified.note, 'Window verified');
  assert.equal(verified.deploymentRun, run);
  await approvals.result(authorization, sha, { run, attempt: '1', state: 'failed' });
  await assert.rejects(approvals.result(authorization, sha, { run, attempt: '1', state: 'succeeded' }), status(409));
  main = randomBytes(20).toString('hex');
  await approvals.register(authorization, pending(main));
  await approvals.decide(administrator, main, { decision: 'approved' });
  await approvals.claim(authorization, main, { run: '53', attempt: '1' });
  await approvals.result(authorization, main, { run: '53', attempt: '1', state: 'succeeded' });
  assert.equal((await stored(main)).state, 'succeeded');

  const project = await projects.create(administrator, { code: 'RELEASE-' + sha.slice(0, 8), name: 'Release fixture' });
  await assert.rejects(approvals.projectStatus(member, project.id, '25'), status(404));
  assert.equal(await approvals.projectStatus(administrator, project.id, '25'), null);
  await db.projectTransaction(project.id, async client => {
    const { rows: [repository] } = await client.query(
      `INSERT INTO repositories (project_id, github_repository_id, owner, repo_name, repository_url, default_branch, installation_id)
       VALUES ($1, 1462649547, 'shinelincx', 'aiplatform', 'https://github.com/shinelincx/aiplatform', 'main', 1) RETURNING id`,
      [project.id],
    );
    const { rows: [task] } = await client.query(
      `INSERT INTO tasks (project_id, repository_id, task_code, title, description, priority, acceptance_criteria, created_by)
       VALUES ($1, $2, 'RELEASE', 'Release fixture', '', 'P1', '[]', $3) RETURNING id`,
      [project.id, repository.id, administrator.id],
    );
    const { rows: [run] } = await client.query(
      "INSERT INTO execution_runs (project_id, task_id, repository_id, status) VALUES ($1, $2, $3, 'succeeded') RETURNING id",
      [project.id, task.id, repository.id],
    );
    const patch = 'b'.repeat(64);
    await client.query("INSERT INTO execution_artifacts (run_id, sha256, size, object_key) VALUES ($1, $2, 1, 'fixture')", [run.id, patch]);
    await client.query(
      `INSERT INTO execution_deliveries (run_id, repository_id, requested_by, patch_hash, base_commit, base_branch, branch,
         state, pull_number, pull_state) VALUES ($1, $2, $3, $4, $5, 'main', 'ado/' || $1::uuid::text, 'published', 25, 'merged')`,
      [run.id, repository.id, administrator.id, patch, baseSha],
    );
    await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')", [project.id, member.id]);
  });
  assert.equal((await approvals.projectStatus(member, project.id, '25')).state, 'succeeded');

  if (gateway) {
    const page = '/settings/staging-releases';
    const workflow = '/github/staging-releases';
    const headers = { 'Content-Type': 'application/json' };
    const statusResponse = await githubFetch(gateway + workflow, {
      headers, method: 'POST', body: JSON.stringify(release),
    });
    assert.equal(statusResponse.status, 401);
    const pendingSha = randomBytes(20).toString('hex');
    const registered = await githubFetch(gateway + workflow, {
      headers: { ...headers, Authorization: 'Bearer ' + gatewaySecret },
      method: 'POST', body: JSON.stringify(pending(pendingSha)),
    });
    assert.equal(registered.status, 204);
    const dashboard = await githubFetch(gateway + page, {
      headers: { Cookie: 'ado_session=' + login.token }, redirect: 'manual',
    });
    assert.equal(dashboard.status, 200);
    const html = await dashboard.text();
    assert.ok(html.includes('预发布审批') && html.includes('待人工发布审批') && html.includes('部署日志') && html.includes(pendingSha));
    const memberLogin = await auth.login({ email: member.email, password: memberPassword });
    const memberPage = await githubFetch(gateway + page, {
      headers: { Cookie: 'ado_session=' + memberLogin.token }, redirect: 'manual',
    });
    assert.match(memberPage.headers.get('location'), /issue=forbidden/);
  }
  console.log('Verified administrator decisions, immutable release details, stale version rejection, single claim, and deployment result recovery.');
} finally {
  globalThis.fetch = githubFetch;
  await db.pool.end();
}
