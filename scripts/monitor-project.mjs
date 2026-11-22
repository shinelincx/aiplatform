import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

const projectIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const repositoryPattern = /^[a-z\d-]+\/[a-z\d_.-]+$/i;
const workflowPattern = /^[a-z\d_.-]+\.ya?ml$/i;
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const failureKeys = ['planningFailures', 'qaFailures', 'deliveryFailures', 'workerFailures', 'workerTimeouts'];

function configuration(env) {
  const origin = URL.parse(env.ADO_MONITOR_API_URL ?? '');
  const projectId = env.ADO_MONITOR_PROJECT_ID;
  const email = env.ADO_MONITOR_EMAIL;
  const password = env.ADO_MONITOR_PASSWORD;
  if (!origin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback.has(origin.hostname)))) {
    throw new Error('Set ADO_MONITOR_API_URL to an HTTPS origin or the loopback API.');
  }
  if (!projectIdPattern.test(projectId ?? '') || !email || !password) {
    throw new Error('Set ADO_MONITOR_PROJECT_ID and the monitoring account credentials.');
  }
  const repository = env.ADO_MONITOR_REPOSITORY;
  const workflow = env.ADO_MONITOR_WORKFLOW;
  if ((repository || workflow) && (!repositoryPattern.test(repository ?? '') || !workflowPattern.test(workflow ?? ''))) {
    throw new Error('Set both ADO_MONITOR_REPOSITORY and ADO_MONITOR_WORKFLOW for CI monitoring.');
  }
  return { origin, projectId, email, password, github: repository ? { repository, workflow, token: env.GITHUB_TOKEN } : null };
}

async function request(fetcher, url, service, options) {
  let response;
  try {
    response = await fetcher(url, { ...options, redirect: 'error', signal: globalThis.AbortSignal.timeout(10000) });
  } catch {
    throw new Error(service + ' request unavailable.');
  }
  if (!response.ok) throw new Error(service + ' returned HTTP ' + response.status + '.');
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new Error(service + ' returned invalid JSON.');
  }
}

async function readCi(fetcher, github, binding) {
  const { repository, workflow, token } = github;
  const branch = binding.defaultBranch;
  const url = new URL('/repos/' + repository + '/actions/workflows/' + encodeURIComponent(workflow) + '/runs', 'https://api.github.com');
  url.searchParams.set('branch', branch);
  url.searchParams.set('event', 'push');
  url.searchParams.set('per_page', '1');
  const source = { repository, branch, workflow };
  try {
    const { workflow_runs } = await request(fetcher, url, 'GitHub CI', {
      headers: { Accept: 'application/vnd.github+json', ...(token && { Authorization: 'Bearer ' + token }) },
    });
    if (!Array.isArray(workflow_runs)) throw new Error('Missing workflow run list.');
    const [run] = workflow_runs;
    if (!run) return { ...source, state: 'no_runs' };
    if (run.event !== 'push' || run.head_branch !== branch || run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
        !Number.isSafeInteger(run.id) || run.id <= 0 || !/^[0-9a-f]{40}$/i.test(run.head_sha ?? '')) {
      throw new Error('Unexpected workflow run metadata.');
    }
    const state = run.status !== 'completed' ? 'pending'
      : run.conclusion === 'success' ? 'success'
        : run.conclusion === 'failure' ? 'failure' : 'other';
    return { ...source, state, runId: run.id, revision: run.head_sha,
      url: 'https://github.com/' + repository + '/actions/runs/' + run.id };
  } catch {
    return { ...source, state: 'unavailable' };
  }
}

function suggestions(snapshot, ci) {
  const findings = [];
  if (snapshot.recentAffectedTasks > 0) {
    findings.push({
      key: 'recent-agent-failures',
      source: 'incidents',
      impact: { affectedTasks: snapshot.recentAffectedTasks },
      proposal: '查阅近期规划和 QA 失败类别，区分恢复后的历史记录与当前故障。',
      benefit: '保留重复失败的证据，并优先处理仍有影响的任务。',
      risk: '时间窗口会重叠，限流原因需要进一步核实。',
      cost: '一次人工复核。',
      riskLevel: 'read_only',
    });
  }
  const openFailures = failureKeys.reduce((sum, key) => sum + snapshot.current[key], 0);
  if (openFailures > 0) {
    findings.push({
      key: 'current-failed-work',
      source: 'current',
      impact: { failures: openFailures },
      proposal: '在项目工作台核对当前失败或超时任务，确认负责人和处理顺序。',
      benefit: '优先处理仍阻塞交付的任务。',
      risk: '任务状态可能在采样后更新。',
      cost: '一次工作台复核。',
      riskLevel: 'read_only',
    });
  }
  if (ci.state === 'failure') {
    findings.push({
      key: 'default-branch-ci-failure',
      source: 'ci',
      impact: { revision: ci.revision, runId: ci.runId },
      proposal: '核对默认分支上该提交的失败作业。',
      benefit: '把 CI 问题与具体变更关联。',
      risk: '重新运行可能改变该运行的结论。',
      cost: '一次 CI 日志复核。',
      riskLevel: 'read_only',
    });
  }
  return findings;
}

export async function monitorProject(env, fetcher = globalThis.fetch) {
  const { origin, projectId, email, password, github } = configuration(env);
  const sessionUrl = new URL('/auth/session', origin);
  const { token } = await request(fetcher, sessionUrl, 'ADO sign-in', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  if (!/^[0-9a-f]{64}$/i.test(token ?? '')) throw new Error('ADO sign-in returned an invalid session.');
  const options = { headers: { Authorization: 'Bearer ' + token } };
  const projectPath = '/projects/' + projectId;
  try {
    const snapshot = await request(fetcher, new URL(projectPath + '/operations/monitoring', origin), 'ADO project monitoring', options);
    if (!snapshot || !snapshot.project || !snapshot.current || !Array.isArray(snapshot.incidents) ||
        !Number.isSafeInteger(snapshot.recentAffectedTasks) ||
        ![...failureKeys, 'queuedExecutions'].every((key) => Number.isSafeInteger(snapshot.current[key]))) {
      throw new Error('ADO monitoring returned incomplete data.');
    }
    let ci = { state: 'skipped' };
    if (github) {
      const bindings = await request(fetcher, new URL(projectPath + '/repositories', origin), 'ADO repository bindings', options);
      const binding = Array.isArray(bindings) && bindings.find(({ fullName }) => fullName?.toLowerCase() === github.repository.toLowerCase());
      if (!binding?.defaultBranch) throw new Error('The CI repository is not bound to the selected project.');
      ci = await readCi(fetcher, github, binding);
    }
    return { ...snapshot, ci, suggestions: suggestions(snapshot, ci) };
  } finally {
    const signOut = () => request(fetcher, sessionUrl, 'ADO sign-out', { ...options, method: 'DELETE' });
    await signOut().catch(signOut);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    console.log(JSON.stringify(await monitorProject(process.env)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
