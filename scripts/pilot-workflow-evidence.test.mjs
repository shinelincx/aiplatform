import { URL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { verifyWorkflow } from './pilot-workflow-evidence.mjs';

const delivery = { pullNumber: 17, baseBranch: 'main', branch: 'ado/execution', commitSha: 'a'.repeat(40) };
const mergedPull = { created_at: '2026-01-01T13:00:00Z', merged_at: '2026-01-01T14:00:00Z' };
const success = { status: 'completed', conclusion: 'success' };
const fitbest = { projectCode: 'FITBEST', repository: 'shinelincx/fitbest' };
const ado = { projectCode: 'ADO', repository: 'shinelincx/aiplatform' };

function workflow(pilot, overrides = {}) {
  return {
    id: 421, run_number: 11, run_attempt: 1, event: 'pull_request', ...success,
    head_sha: delivery.commitSha, head_branch: delivery.branch, head_repository: { full_name: pilot.repository },
    pull_requests: [{
      number: delivery.pullNumber, base: { ref: delivery.baseBranch },
      head: { ref: delivery.branch, sha: delivery.commitSha },
    }],
    ...overrides,
  };
}

function job(name, runAttempt, steps = []) {
  return { name, head_sha: delivery.commitSha, run_attempt: runAttempt, steps, ...success };
}

it('accepts a partial rerun while keeping the successful job from the original attempt', async () => {
  const read = vi.fn(async (path) => {
    const url = new URL(path, 'https://api.github.com');
    if (url.pathname.endsWith('/workflows/ci.yml/runs')) {
      expect(url.searchParams.get('head_sha')).toBe(delivery.commitSha);
      expect(url.searchParams.get('event')).toBe('pull_request');
      expect(url.searchParams.get('branch')).toBe(delivery.branch);
      return { total_count: 1, workflow_runs: [workflow(ado, { run_attempt: 2 })] };
    }
    expect(url.pathname).toBe('/repos/shinelincx/aiplatform/actions/runs/421/jobs');
    expect(url.searchParams.get('filter')).toBe('all');
    const jobs = [
      job('checks', 1), { ...job('compose', 1), conclusion: 'failure' },
      job('compose', 2, [{ ...success, name: 'Restore isolated backup' }]),
    ];
    return { total_count: jobs.length, jobs };
  });
  await expect(verifyWorkflow(read, ado, delivery, mergedPull)).resolves.toBe(421);
});

it('rejects the latest failed PR workflow even when older or unrelated workflows passed', async () => {
  const exact = workflow(fitbest);
  const read = vi.fn().mockResolvedValue({ total_count: 5, workflow_runs: [
    { ...exact, id: 425, run_number: 15, pull_requests: [{ ...exact.pull_requests[0], number: 18 }] },
    { ...exact, id: 424, run_number: 14, event: 'push' },
    { ...exact, id: 423, run_number: 13, head_sha: 'b'.repeat(40) },
    { ...exact, id: 422, run_number: 12, conclusion: 'failure' },
    exact,
  ] });
  await expect(verifyWorkflow(read, fitbest, delivery, mergedPull)).rejects.toThrow('#422 状态为 failure');
  expect(read).toHaveBeenCalledTimes(1);
});

it('accepts a branch and commit match within the PR lifetime after GitHub removes its PR association', async () => {
  const read = vi.fn()
    .mockResolvedValueOnce({ total_count: 2, workflow_runs: [
      workflow(ado, { id: 422, run_number: 12, pull_requests: [], created_at: '2026-01-01T15:00:00Z' }),
      workflow(ado, { pull_requests: [], created_at: '2026-01-01T13:00:02Z' }),
    ] })
    .mockResolvedValueOnce({ total_count: 2, jobs: [
      job('checks', 1), job('compose', 1, [{ ...success, name: 'Restore isolated backup' }]),
    ] });
  await expect(verifyWorkflow(read, ado, delivery, mergedPull)).resolves.toBe(421);
  expect(read.mock.calls[1][0]).toContain('/runs/421/jobs?');
});

it('requires the Fitbest database and browser integration step to pass', async () => {
  const steps = [
    { ...success, name: 'Build web bundle and run Vitest' },
    { ...success, name: 'Test admin password manager integration' },
    { ...success, name: 'Verify server and browser client integration', conclusion: 'skipped' },
  ];
  const read = vi.fn()
    .mockResolvedValueOnce({ total_count: 1, workflow_runs: [workflow(fitbest)] })
    .mockResolvedValueOnce({ total_count: 1, jobs: [job('Build and test', 1, steps)] });
  await expect(verifyWorkflow(read, fitbest, delivery, mergedPull))
    .rejects.toThrow('Verify server and browser client integration 缺少通过记录');
});
