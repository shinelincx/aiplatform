import { workerDiskPressure, type CheckFailureReason, type CheckResult, type ExecutionEvent, type ExecutionRun,
  type Project, type Task, type VerificationCheck, type WorkerReport } from '@ado/shared';
import { changeExecutionWorker, publishExecution, refreshDelivery, retryExecutionQa, reviewExecution, startExecution, stopExecution } from './actions';
import { read } from './api-client';
import { RefreshExecution } from './refresh-execution';

const stateLabels: Record<ExecutionRun['status'], string> = {
  queued: '等待 Worker', running: '执行中', succeeded: '变更已生成，待测试',
  failed: '执行失败', cancelled: '已取消', timed_out: '执行超时',
};
const eventLabels: Record<string, string> = {
  checkout: '准备 Git 工作区', inference: '调用 Codex', collecting: '收集变更',
  source_unavailable: '无法检出仓库', sandbox_rejected: '环境隔离检查未通过',
  codex_failed: 'Codex 执行失败', no_changes: 'Codex 未生成代码变更',
  worker_timeout: 'Worker 执行超时', worker_error: 'Worker 处理失败',
  worker_restarted: 'Worker 重启时执行尚未完成',
  npm_cache_unavailable: '无法准备仓库的 npm 缓存',
  maven_cache_unavailable: '无法准备仓库的 Maven 缓存',
  repair: '根据检查结果修复', checks_changed_candidate: '测试改动了待审核补丁',
  artifact_upload_failed: '补丁归档失败',
  agent_message: 'Codex 回复', command_execution: '命令执行', file_change: '文件变更', mcp_tool_call: 'MCP 工具调用',
};
function label(event: ExecutionEvent) {
  if (event.kind === 'thread') return 'Codex 线程已创建';
  if (event.kind === 'result') return '变更结果已入库';
  if (event.kind === 'verification') return `第 ${event.payload.attempt} 次检查 · ${event.payload.passed ? '通过' : '未通过'}`;
  if (event.kind === 'cancelled') return 'Worker 已取消执行';
  if (event.kind === 'turn' && typeof event.payload.attempt === 'number') {
    const { attempt, phase, durationMs } = event.payload;
    const state = phase === 'started' ? '开始' : phase === 'failed' ? '失败' : '完成';
    const duration = typeof durationMs === 'number' ? ` · ${(durationMs / 1000).toFixed(2)} 秒` : '';
    return `第 ${attempt} 轮 Codex · ${state}${duration}`;
  }
  if (event.kind === 'item' && typeof event.payload.itemType === 'string' && Object.hasOwn(eventLabels, event.payload.itemType)) {
    const { itemType, phase, status, exitCode, fileCount } = event.payload;
    const state = phase === 'started' ? '开始' : status === 'failed' ? '失败' : '完成';
    const details = [
      typeof exitCode === 'number' ? `退出码 ${exitCode}` : null,
      typeof fileCount === 'number' ? `${fileCount} 个文件` : null,
    ].filter(Boolean);
    return [eventLabels[itemType], state, ...details].join(' · ');
  }
  const key = event.kind === 'progress' ? event.payload.stage : event.payload.code;
  return typeof key === 'string' && Object.hasOwn(eventLabels, key) ? eventLabels[key] : '执行记录';
}

const checkLabels = { passed: '通过', failed: '失败', timed_out: '超时', unavailable: '无法运行' } as const;
const checkReasons: Record<CheckFailureReason, string> = {
  directory_unavailable: '检查目录不存在或超出工作区',
  executable_unavailable: 'Worker 缺少检查所需的可执行文件',
  start_failed: '无法启动检查进程',
  process_terminated: '检查进程意外退出',
  timeout: '达到检查时间上限',
  nonzero_exit: '检查命令返回非零退出码',
};
const deliveryLabels = { queued: '等待发布', publishing: '正在发布分支', published: '草稿 PR 已关联', failed: '发布失败' };
const pullLabels = { open: '开放', closed: '已关闭', merged: '已合并', changed: 'PR 与审核版本不匹配' };
const qaLabels = { queued: '等待 QA', running: 'QA 审查中', failed: 'QA 审查失败', completed: 'QA 已提交意见', cancelled: 'QA 已取消' };
const qaRecommendations = { ready: '建议进入评审', changes_requested: '建议修改', insufficient_evidence: '证据不足' };
const deliveryErrors: Record<string, string> = {
  base_changed: '测试基准已不属于发布目标分支，请重新执行。',
  patch_rejected: '补丁无法应用到原始基准。',
  branch_conflict: '执行分支已关联其他提交。',
  git_failed: 'Git 无法发布分支，请检查目标仓库和权限。',
  github_failed: 'GitHub 发布或 PR 创建失败，请检查安装权限后重试。',
};

function WorkerChoice({ workers, selected }: { workers: WorkerReport[]; selected?: string | null }) {
  return <label>执行 Worker<select name="workerId" defaultValue={selected ?? ''}>
    <option value="">自动分配</option>
    {selected && !workers.some(({ id }) => id === selected) &&
      <option value={selected}>当前指定 Worker 不可用</option>}
    {workers.map(({ id, name, status, capabilities }) => (
      <option key={id} value={id}>{name} · {status !== 'online' ? '离线'
        : capabilities && workerDiskPressure(capabilities) ? '磁盘空间不足' : '在线'}</option>
    ))}
  </select></label>;
}

function CheckResults({ checks }: { checks: CheckResult[] }) {
  return <ul className="members">{checks.map((check) => <li key={check.name}>
    <div>
      <span>{check.name} · {checkLabels[check.status]}</span>
      {check.reason && <div><small>{checkReasons[check.reason]}</small></div>}
    </div>
    <small>{(check.durationMs / 1000).toFixed(2)} 秒{check.exitCode !== null && ` · 退出码 ${check.exitCode}`}</small>
  </li>)}</ul>;
}

export async function Executions({ project, task, checks, autoDraftPr, planned }: {
  project: Project; task: Task; checks: VerificationCheck[]; autoDraftPr: boolean; planned: boolean;
}) {
  const url = `/projects/${project.id}/tasks/${task.id}/executions`;
  const [runsResult, workersResult] = await Promise.all([
    read<ExecutionRun[]>(url), read<WorkerReport[]>(`/projects/${project.id}/workers`),
  ]);
  const runs = runsResult ?? [];
  const workers = workersResult ?? [];
  const latest = runs[0];
  const scheduledChecks = latest?.status === 'queued' ? latest.checkPlan ?? checks : checks;
  const hasChecks = scheduledChecks.length > 0;
  const needsMaven = scheduledChecks.some(({ argv }) => argv[0] === 'mvn');
  const events = latest ? await read<ExecutionEvent[]>(`${url}/${latest.id}/events`) : null;
  const earlierChecks = events?.filter(({ kind, payload }) =>
    kind === 'verification' && typeof payload.attempt === 'number' && payload.attempt < (latest?.report?.attempt ?? 0));
  const active = latest?.status === 'queued' || latest?.status === 'running';
  const waitingOnGithub = latest?.delivery?.state === 'queued' && !latest.delivery.configured;
  const publishing = (latest?.delivery?.state === 'queued' && !waitingOnGithub) || latest?.delivery?.state === 'publishing';
  const owner = project.role === 'owner';
  const checkingQa = latest?.qa?.state === 'queued' || latest?.qa?.state === 'running';
  const canManageQa = owner && project.status === 'active' && task.status === 'TESTING';
  const awaitingChecks = task.status === 'TESTING' && latest?.status === 'succeeded' && !latest.report;
  const canStart = owner && project.status === 'active' && !task.archivedAt && task.repositoryId
    && (['READY', 'FAILED', 'TIMEOUT'].includes(task.status) || (awaitingChecks && hasChecks));
  const candidates = workers.filter(({ status, capabilities }) =>
    status !== 'disabled' && Boolean(capabilities?.codexVersion)
    && (!hasChecks || capabilities?.verificationVersion === 1)
    && (!needsMaven || capabilities?.mavenVerification === true)
    && (!hasChecks || (!autoDraftPr && !planned) || capabilities?.artifactVersion === 1));
  const waitingForMaven = latest?.status === 'queued' && needsMaven
    && !candidates.some(({ id, status, capabilities }) =>
      status === 'online' && capabilities && !workerDiskPressure(capabilities)
      && (!latest.requestedWorkerId || latest.requestedWorkerId === id));
  const workerName = (id: string) => workers.find((worker) => worker.id === id)?.name ?? id.slice(0, 8);
  const identity = <>
    <input type="hidden" name="projectId" value={project.id} />
    <input type="hidden" name="taskId" value={task.id} />
  </>;

  return <section aria-labelledby="execution-heading" className="repository-form">
    <h4 id="execution-heading">Codex 执行</h4>
    {(active || publishing || (checkingQa && project.status === 'active')) && <RefreshExecution />}
    {canStart && <form action={startExecution} className="fields">
      {identity}<WorkerChoice workers={candidates} /><button>{latest ? '重试执行' : '派发任务'}</button>
    </form>}
    {!latest && <p className="muted">暂无执行记录。</p>}
    {latest && <>
      <p role="status">{latest.cancelRequested && active ? '正在取消'
        : latest.status === 'succeeded' && latest.report?.passed ? '检查已通过' : stateLabels[latest.status]}</p>
      {waitingForMaven && <p className="feedback">当前分配范围内没有可领取任务的 Maven Worker。</p>}
      {owner && awaitingChecks && !hasChecks && <p className="muted">配置仓库检查计划后可重新派发。</p>}
      {latest.requestedWorkerId && <p>指定 Worker · {workerName(latest.requestedWorkerId)}</p>}
      {latest.workerId && <p>领取 Worker · {workerName(latest.workerId)}</p>}
      {owner && project.status === 'active' && latest.status === 'queued' && <form action={changeExecutionWorker} className="fields">
        {identity}<input type="hidden" name="runId" value={latest.id} />
        <WorkerChoice key={latest.requestedWorkerId} workers={candidates} selected={latest.requestedWorkerId} />
        <button className="secondary">更新分配</button>
      </form>}
      {latest.threadId && <p className="description">线程 ID {latest.threadId}</p>}
      {owner && active && !latest.cancelRequested && <form action={stopExecution}>
        {identity}<input type="hidden" name="runId" value={latest.id} /><button className="secondary">取消执行</button>
      </form>}
      {latest.report && <div>
        <h5>第 {latest.report.attempt} 次检查报告</h5>
        <CheckResults checks={latest.report.checks} />
        {earlierChecks?.map(({ sequence, payload }) => Array.isArray(payload.checks) &&
          <details key={sequence}>
            <summary>第 {String(payload.attempt)} 次检查报告</summary>
            <CheckResults checks={payload.checks as CheckResult[]} />
          </details>)}
      </div>}
      {latest.artifact && <p><a href={`/artifacts/${project.id}/${task.id}/${latest.id}`}>下载受测补丁</a>
        {' '}<small>{Math.ceil(latest.artifact.size / 1024)} KB</small></p>}
      {latest.qa && <div>
        <h5>QA Agent · v{latest.qa.version} · {latest.qa.model}</h5>
        <p role="status">{qaLabels[latest.qa.state]}</p>
        {latest.qa.partialPatch && <p>QA 审查了补丁开头的 64 KiB。</p>}
        {latest.qa.assessment && <>
          <p><strong>{qaRecommendations[latest.qa.assessment.recommendation]}</strong></p>
          <ul>{latest.qa.assessment.findings.map((text, index) => <li key={index}>{text}</li>)}</ul>
          <h5>建议验证用例</h5>
          <ul>{latest.qa.assessment.testCases.map((text, index) => <li key={index}>{text}</li>)}</ul>
        </>}
        {canManageQa && latest.qa.state === 'failed' && <form action={retryExecutionQa}>
          {identity}<input type="hidden" name="runId" value={latest.id} /><button className="secondary">重试 QA</button>
        </form>}
        {canManageQa && (checkingQa || latest.qa.state === 'failed') && <form action={stopExecution}>
          {identity}<input type="hidden" name="runId" value={latest.id} /><button className="secondary">取消任务</button>
        </form>}
      </div>}
      {latest.review ? <div>
        <p>人工审核 · {latest.review.decision === 'approved' ? '已批准' : '已驳回'} · {latest.review.reviewer}</p>
        {latest.review.comment && <p className="description">{latest.review.comment}</p>}
      </div> : owner && project.status === 'active' && task.status === 'REVIEW' && latest.report?.passed
        && <form action={reviewExecution} className="fields">
          {identity}<input type="hidden" name="runId" value={latest.id} />
          {autoDraftPr && latest.artifact && <p>批准变更后将自动发布分支并创建草稿 PR。</p>}
          <label>审核意见<textarea name="comment" maxLength={1500} placeholder="驳回时请填写原因" /></label>
          <div className="inline-fields">
            <button name="decision" value="approved">批准变更</button>
            <button name="decision" value="rejected" className="secondary">驳回变更</button>
          </div>
        </form>}
      {latest.delivery && <div>
        <p role="status">{waitingOnGithub ? '等待 GitHub App 配置' : deliveryLabels[latest.delivery.state]}
          {latest.delivery.pullState && ` · ${pullLabels[latest.delivery.pullState]}`}</p>
        <p className="description">{latest.delivery.branch} → {latest.delivery.baseBranch}</p>
        {latest.delivery.pullUrl && <p><a href={latest.delivery.pullUrl}>查看 GitHub PR #{latest.delivery.pullNumber}</a></p>}
        {owner && project.status === 'active' && latest.delivery.state === 'published' && latest.delivery.pullState !== 'merged'
          && <form action={refreshDelivery} className="fields">
            {identity}<input type="hidden" name="runId" value={latest.id} />
            <button>同步 GitHub PR 状态</button>
          </form>}
        {latest.delivery.error && <p className="feedback">{deliveryErrors[latest.delivery.error] ?? '发布失败，请重试。'}</p>}
      </div>}
      {owner && project.status === 'active' && task.status === 'REVIEW' && latest.review?.decision === 'approved'
        && latest.report?.passed && latest.artifact && (!latest.delivery || latest.delivery.state === 'failed')
        && <form action={publishExecution} className="fields">
          {identity}<input type="hidden" name="runId" value={latest.id} />
          <button>{latest.delivery ? '重试发布' : '发布分支并创建草稿 PR'}</button>
        </form>}
      {events?.length ? <ol className="members">
        {events.map((event) => (
          <li key={event.sequence}>
            <div><span>{label(event)}</span>
              {event.kind === 'result' && Array.isArray(event.payload.files) &&
                <ul>{event.payload.files.filter((name): name is string => typeof name === 'string')
                  .map((name, i) => <li key={i}>{name}</li>)}</ul>}
              {event.kind === 'result' && event.payload.usage !== null && typeof event.payload.usage === 'object' &&
                'inputTokens' in event.payload.usage && 'outputTokens' in event.payload.usage &&
                typeof event.payload.usage.inputTokens === 'number' && typeof event.payload.usage.outputTokens === 'number' &&
                <small>截至本轮 · 输入 {event.payload.usage.inputTokens.toLocaleString('zh-CN')} tokens · 输出 {event.payload.usage.outputTokens.toLocaleString('zh-CN')} tokens</small>}
            </div>
            <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</time>
          </li>
        ))}
      </ol> : null}
      {runs.length > 1 && <details>
        <summary>较早的执行</summary>
        <ul className="members">{runs.slice(1).map((run) => <li key={run.id}>
          <span>{stateLabels[run.status]}</span><time dateTime={run.createdAt}>{new Date(run.createdAt)
            .toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</time>
        </li>)}</ul>
      </details>}
    </>}
  </section>;
}
