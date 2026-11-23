import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { sign } from 'node:crypto';
import process from 'node:process';
import { URL, URLSearchParams } from 'node:url';
import { databaseReviewReasons } from './ado-database-changes.mjs';

const repo = 'shinelincx/aiplatform';
const repositoryId = 1462649547;
const checkName = 'ado-merge-gate';
const sha = /^[0-9a-f]{40}$/;
const env = process.env;
const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
let token;

async function github(path, { method = 'GET', body, credential = token } = {}) {
  const response = await globalThis.fetch(`https://api.github.com${path}`, {
    method, redirect: 'error', signal: globalThis.AbortSignal.timeout(15_000),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${credential}`,
      'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`GitHub ${method} request failed (${response.status})`);
  return response.json();
}

async function appToken() {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = [encode({ alg: 'RS256', typ: 'JWT' }),
    encode({ iss: env.RELEASE_APP_ID, iat: now - 30, exp: now + 480 })].join('.');
  const jwt = `${claims}.${sign('RSA-SHA256', Buffer.from(claims), env.RELEASE_APP_KEY).toString('base64url')}`;
  const installation = await github(`/repos/${repo}/installation`, { credential: jwt });
  const access = await github(`/app/installations/${installation.id}/access_tokens`, {
    method: 'POST', credential: jwt, body: { repository_ids: [repositoryId] },
  });
  return access.token;
}

async function publishCheck(head, run, conclusion, summary) {
  const query = new URLSearchParams({ check_name: checkName, app_id: env.RELEASE_APP_ID });
  const existing = (await github(`/repos/${repo}/commits/${head}/check-runs?${query}`)).check_runs[0];
  return github(`/repos/${repo}/check-runs${existing ? `/${existing.id}` : ''}`, {
    method: existing ? 'PATCH' : 'POST',
    body: { name: checkName, ...(!existing && { head_sha: head }), status: conclusion ? 'completed' : 'in_progress',
      ...(conclusion && { conclusion }), details_url: run.html_url, output: { title: 'ADO merge gate', summary } },
  });
}

async function candidateProof(pull) {
  const url = new URL('https://ado.thinkfiter.com/github/webhook');
  url.search = new URLSearchParams({ pull: String(pull.number), head: pull.head.sha });
  const response = await globalThis.fetch(url, {
    redirect: 'error', signal: globalThis.AbortSignal.timeout(12_000),
    headers: { Authorization: `Bearer ${env.RELEASE_GATE_SECRET}` },
  });
  if (!response.ok) throw new Error(`ADO evidence check failed (${response.status})`);
  return response.json();
}

if (env.GITHUB_REPOSITORY !== repo || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Release gate is limited to main');
if (!env.RELEASE_APP_ID || !env.RELEASE_APP_KEY || !env.RELEASE_GATE_SECRET) {
  process.stdout.write('Release gate credentials are pending configuration.\n');
  process.exit(0);
}

const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
if (!manual && (event.workflow_run?.event !== 'pull_request' || event.workflow_run?.conclusion !== 'success')) process.exit(0);
if (manual && (event.sender?.login !== 'shinelincx' || !sha.test(event.inputs?.head ?? ''))) {
  throw new Error('Manual gate requires repository owner authorization for a specific commit');
}

token = await appToken();
const reported = event.workflow_run;
let number = manual ? Number(event.inputs.pull) : reported.pull_requests?.[0]?.number;
if (!manual && !number && sha.test(reported.head_sha)) {
  const linked = await github(`/repos/${repo}/commits/${reported.head_sha}/pulls?per_page=20`);
  const matches = linked.filter((item) => item.state === 'open' && item.base.ref === 'main'
    && item.head.sha === reported.head_sha && item.head.ref === reported.head_branch
    && item.head.repo?.id === reported.head_repository?.id);
  if (matches.length === 1) number = matches[0].number;
}
if (!Number.isSafeInteger(number) || number < 1) process.exit(0);
const pullPath = `/repos/${repo}/pulls/${number}`;
const pull = await github(pullPath);
const head = pull.head.sha;
if (pull.state !== 'open' || pull.base.ref !== 'main' || pull.base.repo.id !== repositoryId || !sha.test(head)) process.exit(0);

const runList = manual ? await github(`/repos/${repo}/actions/workflows/ci.yml/runs?${new URLSearchParams({
  event: 'pull_request', head_sha: head, status: 'success', per_page: '20',
})}`) : { workflow_runs: [event.workflow_run] };
const run = runList.workflow_runs.find((item) => item.head_sha === head && item.path?.split('@')[0] === '.github/workflows/ci.yml'
  && item.repository?.id === repositoryId && item.head_branch === pull.head.ref && item.head_repository?.id === pull.head.repo?.id
  && (!item.pull_requests?.length || item.pull_requests.some((pr) => pr.number === number && pr.base.ref === 'main')));
if (!run || (manual && event.inputs.head !== head)) throw new Error('No passing CI run for this PR and commit');
const jobs = (await github(`/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`)).jobs;
if (!['checks', 'compose'].every((name) => jobs.some((job) => job.name === name && job.conclusion === 'success'))) {
  throw new Error('Required CI jobs did not succeed');
}

if (manual) {
  await publishCheck(head, run, 'success', 'The repository owner explicitly cleared this commit for human merge.');
  process.exit(0);
}

const internal = pull.head.repo?.id === repositoryId && /^ado\/[0-9a-f-]{36}$/.test(pull.head.ref)
  && pull.user.type === 'Bot' && pull.user.login === 'aiplatformapp[bot]';
if (!internal) {
  await publishCheck(head, run, null, 'Owner authorization is required for this PR.');
  process.exit(0);
}
const base = pull.base.sha;
const comparison = sha.test(base) && pull.changed_files > 0 && pull.changed_files <= 300
  ? await github(`/repos/${repo}/compare/${base}...${head}?per_page=1`) : null;
if (!comparison?.files || comparison.files.length !== pull.changed_files) {
  await publishCheck(head, run, null, 'Owner authorization is required because the full PR diff could not be checked.');
  process.exit(0);
}
const databaseReasons = databaseReviewReasons(comparison.files);
if (databaseReasons.length) {
  const matches = databaseReasons.slice(0, 20).map(({ filename, reason }) => `${filename}: ${reason}`);
  await publishCheck(head, run, null, `Owner authorization is required for database changes or unverifiable files.\n\n${matches.join('\n')}`);
  process.exit(0);
}
const proof = await candidateProof(pull);
if (!proof.eligible || pull.head.ref !== `ado/${proof.runId}` || !/^[0-9a-f]{64}$/.test(proof.patchHash)) {
  await publishCheck(head, run, null, 'The current commit has no matching approved ADO candidate.');
  process.exit(0);
}
const reviews = await github(`${pullPath}/reviews?per_page=100`);
if (reviews.length >= 100 || reviews.some((review) => review.state === 'CHANGES_REQUESTED')) {
  await publishCheck(head, run, null, 'Review history requires owner authorization.');
  process.exit(0);
}
const current = await github(pullPath);
if (current.head.sha !== head || current.base.sha !== base || current.base.ref !== 'main' || current.state !== 'open') {
  throw new Error('PR changed during validation');
}
if (current.draft) {
  const result = await github('/graphql', { method: 'POST', body: {
    query: 'mutation($id: ID!) { markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { isDraft } } }',
    variables: { id: current.node_id },
  } });
  if (result.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) throw new Error('Failed to mark PR ready');
}
await github(`${pullPath}/reviews`, { method: 'POST', body: {
  commit_id: head, event: 'APPROVE', body: `ADO candidate and required CI verified for ${head.slice(0, 12)}. ${run.html_url}`,
} });
await publishCheck(head, run, 'success', 'The trusted ADO candidate and required CI passed for this commit.');
const merged = await github(`${pullPath}/merge`, { method: 'PUT', body: { sha: head, merge_method: 'squash' } });
if (!merged.merged) throw new Error('GitHub declined the merge');
process.stdout.write(`Merged #${number} at ${merged.sha}\n`);
