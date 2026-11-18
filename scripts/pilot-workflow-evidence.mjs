import { URLSearchParams } from 'node:url';

const requiredWorkflows = {
  FITBEST: {
    file: 'ci-cd.yml',
    jobs: {
      'Build and test': [
        'Build web bundle and run Vitest',
        'Test admin password manager integration',
        'Verify server and browser client integration',
      ],
    },
  },
  ADO: { file: 'ci.yml', jobs: { checks: [], compose: ['Restore isolated backup'] } },
};

async function list(read, path, key, query) {
  const items = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ ...query, per_page: '100', page: String(page) });
    const body = await read(`${path}?${params}`);
    const batch = body[key];
    if (!Array.isArray(batch)) throw new Error('GitHub Actions 返回的记录格式无效');
    items.push(...batch);
    if (batch.length < 100 || items.length >= body.total_count) return items;
  }
}

function passed(record) {
  return record?.status === 'completed' && record.conclusion === 'success';
}

function belongsToPull(run, delivery, pull) {
  if (run.pull_requests?.length) {
    return run.pull_requests.some((pr) => pr.number === delivery.pullNumber && pr.base?.ref === delivery.baseBranch
      && pr.head?.ref === delivery.branch && pr.head?.sha === delivery.commitSha);
  }
  // GitHub can omit associations after the PR closes and its branch is deleted.
  const createdAt = Date.parse(run.created_at);
  return createdAt >= Date.parse(pull.created_at) && createdAt <= Date.parse(pull.merged_at);
}

export async function verifyWorkflow(read, pilot, delivery, pull) {
  const { file, jobs } = requiredWorkflows[pilot.projectCode];
  const actions = `/repos/${pilot.repository}/actions`;
  const runs = await list(read, `${actions}/workflows/${file}/runs`, 'workflow_runs', {
    event: 'pull_request', head_sha: delivery.commitSha, branch: delivery.branch,
  });
  const run = runs.filter((candidate) => candidate.event === 'pull_request'
      && candidate.head_sha === delivery.commitSha && candidate.head_branch === delivery.branch
      && candidate.head_repository?.full_name?.toLowerCase() === pilot.repository.toLowerCase()
      && belongsToPull(candidate, delivery, pull))
    .sort((a, b) => b.run_number - a.run_number)[0];
  if (!run || !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt)) {
    throw new Error(`缺少关联 PR #${delivery.pullNumber} 及交付提交的 GitHub Actions 运行`);
  }
  if (!passed(run)) throw new Error(`GitHub Actions #${run.id} 状态为 ${run.conclusion ?? run.status}`);

  const results = await list(read, `${actions}/runs/${run.id}/jobs`, 'jobs', { filter: 'all' });
  for (const [name, steps] of Object.entries(jobs)) {
    // Rerunning failed jobs can leave a successful job in an earlier attempt.
    const job = results.filter((result) => result.name === name && result.head_sha === delivery.commitSha
        && Number.isSafeInteger(result.run_attempt) && result.run_attempt <= run.run_attempt)
      .sort((a, b) => b.run_attempt - a.run_attempt || b.id - a.id)[0];
    if (!passed(job)) throw new Error(`GitHub Actions #${run.id} 的作业 ${name} 缺少通过记录`);
    for (const step of steps) {
      if (!job.steps?.some((result) => result.name === step && passed(result))) {
        throw new Error(`GitHub Actions #${run.id} 的步骤 ${step} 缺少通过记录`);
      }
    }
  }
  return run.id;
}
