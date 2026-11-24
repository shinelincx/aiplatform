
import { stagingRepository } from '@ado/shared';
import { stagingRunUrl } from './staging-release-status';

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryApi = 'https://api.github.com/repos/' + stagingRepository;
const stages = [
  { name: 'checks', label: '代码检查' },
  { name: 'compose', label: '集成检查' },
  { name: 'publish', label: '发布镜像' },
  { name: 'plan-staging', label: '部署预检' },
  { name: 'deploy-staging', label: '部署预发布' },
] as const;

const failureReasons: Record<string, string> = {
  ADO_STAGING_BASELINE_DIVERGED: '预发布当前版本不在目标提交的历史中，无法安全计算发布差异。',
  ADO_STAGING_BASELINE_UNAVAILABLE: '无法读取预发布当前版本，部署预检已停止。',
  ADO_STAGING_COORDINATED_REQUIRED: '本次变更需要通过协调发布处理。',
  ADO_STAGING_REGISTRATION_FAILED: '无法登记预发布审批单。',
  ADO_STAGING_PREFLIGHT_FAILED: '目标提交或预发布环境未通过发布前校验。',
  ADO_STAGING_IMAGE_FAILED: '预发布主机拉取或校验发布镜像失败。',
  ADO_STAGING_BUSY: '预发布仍有排队或执行中的任务，或发布锁尚未释放。',
  ADO_STAGING_HEALTH_FAILED: '切换后服务健康、数据或 Worker 重连校验失败。',
};

type Status = 'pending' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped';
type GitHubRun = { id: number; head_sha: string; run_attempt: number; status: string; conclusion: string | null };
type GitHubJob = {
  id: number; name: string; status: string; conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
};

export interface StagingProgress {
  status: string;
  workflow?: {
    url: string;
    active: boolean;
    revision: string;
    stages: { name: string; label: string; status: Status; logUrl?: string }[];
    failure?: string;
    failedStep?: string;
  };
}

const validId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

async function github<T>(path: string, revalidate = 30): Promise<T | null> {
  try {
    const response = await fetch(repositoryApi + path, {
      headers: { Accept: 'application/vnd.github+json' }, redirect: 'error',
      signal: AbortSignal.timeout(3500), next: { revalidate },
    });
    return response.ok ? await response.json() as T : null;
  } catch {
    return null;
  }
}

function stageStatus(job: GitHubJob | undefined, run: GitHubRun): Status {
  if (!job) return run.status === 'completed' && run.conclusion !== 'cancelled' ? 'skipped' : 'pending';
  if (job.status === 'in_progress') return 'running';
  if (job.status !== 'completed') return 'pending';
  if (job.conclusion === 'success') return 'passed';
  if (job.conclusion === 'skipped' || job.conclusion === 'neutral') return 'skipped';
  return job.conclusion === 'cancelled' ? 'cancelled' : 'failed';
}

async function workflowFor(revision: string, deployedBaselineDiverged: boolean) {
  const query = new URLSearchParams({ branch: 'main', event: 'push', head_sha: revision, per_page: '5' });
  const result = await github<{ workflow_runs?: GitHubRun[] }>('/actions/workflows/ci.yml/runs?' + query);
  const run = result?.workflow_runs?.find(item => item.head_sha === revision && validId(item.id) && validId(item.run_attempt));
  if (!run) return;
  const url = stagingRunUrl(String(run.id));
  const jobs = await github<{ jobs?: GitHubJob[] }>('/actions/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs', run.status === 'completed' ? 300 : 30);
  const active = run.status !== 'completed';
  const current = stages.map(stage => {
    const job = jobs?.jobs?.find(item => item.name === stage.name && validId(item.id));
    return { ...stage, job, status: stageStatus(job, run), logUrl: job ? url + '/job/' + job.id : undefined };
  });
  const failed = current.find(stage => stage.status === 'failed');
  let failure = failed ? failed.label + '失败。打开对应步骤的日志查看细节。' : undefined;
  if (failed?.job && (failed.name === 'plan-staging' || failed.name === 'deploy-staging')) {
    const annotations = await github<{ title?: string; message?: string }[]>('/check-runs/' + failed.job.id + '/annotations', 300);
    const code = annotations?.find(item => item.title === 'ADO staging release' &&
      typeof item.message === 'string' && Object.hasOwn(failureReasons, item.message.trim()))?.message?.trim();
    if (code) failure = failureReasons[code];
    else if (failed.name === 'plan-staging' && deployedBaselineDiverged) failure = failureReasons.ADO_STAGING_BASELINE_DIVERGED;
  }
  const failedStep = failed?.job?.steps?.find(step => step.conclusion === 'failure')?.name;
  return { active, url, revision, failure, failedStep,
    stages: jobs?.jobs ? current.map(({ name, label, status, logUrl }) => ({ name, label, status, logUrl })) : [] };
}

export async function readStagingProgress(pullNumber: number, deployed?: string): Promise<StagingProgress> {
  const pending = '预发布部署待核对';
  if (!validId(pullNumber)) return { status: pending };
  const pull = await github<{ merged?: boolean; merge_commit_sha?: string }>('/pulls/' + pullNumber, 300);
  const merged = pull?.merge_commit_sha;
  if (pull?.merged !== true || !merged || !shaPattern.test(merged)) return { status: pending };

  const baseKnown = Boolean(deployed && shaPattern.test(deployed));
  const comparison = baseKnown && deployed !== merged
    ? await github<{ status?: string }>('/compare/' + merged + '...' + deployed, 300) : null;
  const included = deployed === merged || comparison?.status === 'ahead' || comparison?.status === 'identical';
  const status = included ? '已部署预发布' : comparison?.status ? '待部署预发布' : pending;

  // The active main release may include this PR through a later merge. Show the rollout that is actually running.
  const live = included && deployed && deployed !== merged ? await workflowFor(deployed, false) : undefined;
  const workflow = live ?? await workflowFor(merged, comparison?.status === 'diverged');
  return { status, workflow };
}
