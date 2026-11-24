
import { afterEach, expect, it, vi } from 'vitest';
import { readStagingProgress } from './staging-release-progress';

const merged = 'a'.repeat(40);
const staging = 'b'.repeat(40);

afterEach(() => vi.unstubAllGlobals());

it('shows the deployment-preflight reason and job logs when the merged PR has not been deployed', async () => {
  const reply = (data: unknown) => Response.json(data);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/pulls/28')) return reply({ merged: true, merge_commit_sha: merged });
    if (url.includes('/compare/')) return reply({ status: 'diverged' });
    if (url.includes('/workflows/ci.yml/runs?') && url.includes('head_sha=' + merged)) {
      return reply({ workflow_runs: [{ id: 100, run_attempt: 2, head_sha: merged, status: 'completed', conclusion: 'failure' }] });
    }
    if (url.endsWith('/attempts/2/jobs')) return reply({ jobs: [
      { id: 200, name: 'plan-staging', status: 'completed', conclusion: 'failure', steps: [{ name: 'Plan staging', conclusion: 'failure' }] },
      { id: 201, name: 'deploy-staging', status: 'completed', conclusion: 'skipped' },
    ] });
    if (url.endsWith('/check-runs/200/annotations')) return reply([{ title: '', message: 'Process exit code 1' }]);
    throw Error('Unexpected request ' + url);
  }));

  const result = await readStagingProgress(28, staging);
  expect(result).toMatchObject({ status: '待部署预发布', workflow: {
    active: false, revision: merged, failure: '预发布当前版本不在目标提交的历史中，无法安全计算发布差异。',
    failedStep: 'Plan staging',
  } });
  expect(result.workflow?.stages.find(stage => stage.name === 'plan-staging')).toMatchObject({
    status: 'failed', logUrl: 'https://github.com/shinelincx/aiplatform/actions/runs/100/job/200',
  });
});

it('links to the descendant release when it has already brought this PR to staging', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/pulls/28')) return Response.json({ merged: true, merge_commit_sha: merged });
    if (url.includes('/compare/')) return Response.json({ status: 'ahead' });
    if (url.includes('/workflows/ci.yml/runs?') && url.includes('head_sha=' + staging)) {
      return Response.json({ workflow_runs: [{ id: 101, run_attempt: 1, head_sha: staging, status: 'completed', conclusion: 'success' }] });
    }
    if (url.endsWith('/attempts/1/jobs')) return Response.json({ jobs: [
      { id: 300, name: 'deploy-staging', status: 'completed', conclusion: 'success' },
    ] });
    throw Error('Unexpected request ' + url);
  }));

  await expect(readStagingProgress(28, staging)).resolves.toMatchObject({ status: '已部署预发布', workflow: {
    url: 'https://github.com/shinelincx/aiplatform/actions/runs/101', revision: staging,
    stages: expect.arrayContaining([expect.objectContaining({ name: 'deploy-staging', status: 'passed' })]),
  } });
});
