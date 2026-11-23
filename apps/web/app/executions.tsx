import { executionQualityGate, independentCheckStatuses, workerDiskPressure, type CheckFailureReason, type CheckResult,
  type ExecutionEvent, type ExecutionRun, type IndependentCheck, type Project, type ReviewEvidence, type Task,
  type VerificationCheck, type WorkerReport } from '@ado/shared';
import { addExecutionEvidence, changeExecutionWorker, publishExecution, refreshDelivery, retryExecutionQa,
  reviewExecution, startExecution } from './actions';
import { ActionDialog } from './console-controls';
import { readSection } from './api-client';
import { SectionReadError } from './section-feedback';
import { RefreshExecution } from './refresh-execution';
import { TaskActivity, type ActivityItem } from './task-activity';
import { SubmitButton } from './task-feedback';
import { executionFailureLabels } from './workspace';

const stateLabels: Record<ExecutionRun['status'], string> = {
  queued: '等待 Worker', running: '执行中', succeeded: '变更已生成，待测试',
  failed: '执行失败', cancelled: '已取消', timed_out: '执行超时',
};
const eventLabels: Record<string, string> = {
  checkout: '准备 Git 工作区', inference: '调用 Codex', collecting: '收集变更',
  ...executionFailureLabels, repair: '根据检查结果修复',
  agent_message: 'Codex 回复', command_execution: '命令执行', file_change: '文件变更', mcp_tool_call: 'MCP 工具调用',
};
function label(event: ExecutionEvent) {
  if (event.kind === 'progress' && event.payload.stage === 'revision') {
    return event.payload.outcome === 'applied' ? '前序补丁已校验并应用' : '前序补丁未能恢复';
  }
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

function executionActivity(event: ExecutionEvent): ActivityItem {
  const { payload, kind } = event;
  const failed = ['error', 'failure', 'failed'].includes(kind) || payload.status === 'failed' ||
    payload.phase === 'failed' || payload.passed === false || payload.outcome === 'failed';
  const usage = payload.usage;
  const detail = kind === 'result' && usage !== null && typeof usage === 'object'
    && 'inputTokens' in usage && 'outputTokens' in usage
    && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
    ? `截至本轮 · 输入 ${usage.inputTokens.toLocaleString('zh-CN')} tokens · 输出 ${usage.outputTokens.toLocaleString('zh-CN')} tokens`
    : undefined;
  return {
    id: String(event.sequence), at: event.createdAt, label: label(event),
    group: failed ? '异常' : kind === 'verification' ? '检查' : kind === 'result' ? '产物'
      : kind === 'item' || kind === 'turn' ? 'Codex' : '进度',
    tone: failed ? 'rose' : kind === 'verification' || kind === 'result' ? 'mint' : undefined,
    detail,
    files: kind === 'result' && Array.isArray(payload.files)
      ? payload.files.filter((name): name is string => typeof name === 'string') : undefined,
  };
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
  quality_gate: '此归档未满足必需检查，发布已停止。',
  base_changed: '测试基准已不属于发布目标分支，请重新执行。',
  patch_rejected: '补丁无法应用到原始基准。',
  branch_conflict: '执行分支已关联其他提交。',
  git_failed: 'Git 无法发布分支，请检查目标仓库和权限。',
  github_failed: 'GitHub 发布或 PR 创建失败，请检查安装权限后重试。',
};

function WorkerChoice({ workers, selected }: { workers?: WorkerReport[]; selected?: string | null }) {
  return <label>执行 Worker<select name="workerId" defaultValue={selected ?? ''}>
    <option value="">自动分配</option>
    {selected && !workers?.some(({ id }) => id === selected) &&
      <option value={selected}>{workers ? '当前指定 Worker 不可用' : '当前指定 Worker（列表未加载）'}</option>}
    {workers?.map(({ id, name, status, capabilities }) => (
      <option key={id} value={id}>{name} · {status !== 'online' ? '离线'
        : capabilities && workerDiskPressure(capabilities) ? '磁盘空间不足' : '在线'}</option>
    ))}
  </select></label>;
}

function CheckResults({ checks }: { checks: CheckResult[] }) {
  return <ul className="check-list">{checks.map((check) => <li key={check.name} data-status={check.status}>
    <div>
      <span>{check.name} · {checkLabels[check.status]}</span>
      {check.reason && <div><small>{checkReasons[check.reason]}</small></div>}
    </div>
    <small>{(check.durationMs / 1000).toFixed(2)} 秒{check.exitCode !== null && ` · 退出码 ${check.exitCode}`}</small>
  </li>)}</ul>;
}

function EvidenceList({ entries }: { entries?: ReviewEvidence[] }) {
  if (!entries?.length) return null;
  return <ul className="members">{entries.map((entry, i) => <li key={`${entry.recordedAt}-${i}`}>
    <div><p className="description">{entry.summary}</p>
      {entry.check && <p><strong>{entry.check.name} · {checkLabels[entry.check.status]}</strong> · {entry.check.environment}</p>}
      {entry.url && <p><a href={entry.url} rel="noreferrer">打开证据链接</a></p>}
      <small>{entry.author} · 补丁 <code title={entry.patchHash}>{entry.patchHash.slice(0, 12)}</code></small>
    </div>
    <time dateTime={entry.recordedAt}>{new Date(entry.recordedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</time>
  </li>)}</ul>;
}

export async function Executions({ project, task, runsResult, checks, independentChecks, autoDraftPr, planned, approvals }: {
  project: Project; task: Task; runsResult: Awaited<ReturnType<typeof readSection<ExecutionRun[]>>>;
  checks: VerificationCheck[]; independentChecks: IndependentCheck[]; autoDraftPr: boolean; planned: boolean; approvals: boolean;
}) {
  const url = `/projects/${project.id}/tasks/${task.id}/executions`;
  if (runsResult.issue) return <div id="execution-heading"><SectionReadError label="任务执行" issue={runsResult.issue} /></div>;
  const runs = runsResult.data;
  const latest = runs[0];
  const [workersResult, eventsResult] = await Promise.all([
    readSection<WorkerReport[]>(`/projects/${project.id}/workers`, Array.isArray),
    latest ? readSection<ExecutionEvent[]>(`${url}/${latest.id}/events`, Array.isArray) : null,
  ]);
  const workers = workersResult.data ?? [];
  const scheduledChecks = latest?.status === 'queued' ? latest.checkPlan ?? checks : checks;
  const scheduledIndependent = latest?.status === 'queued' ? latest.independentChecks ?? [] : independentChecks;
  const hasChecks = scheduledChecks.length > 0;
  const gate = latest && executionQualityGate(latest, latest.artifact?.sha256);
  const needsMaven = scheduledChecks.some(({ argv }) => argv[0] === 'mvn');
  const events = eventsResult?.data;
  const earlierChecks = events?.filter(({ kind, payload }) =>
    kind === 'verification' && typeof payload.attempt === 'number' && payload.attempt < (latest?.report?.attempt ?? 0));
  const active = latest?.status === 'queued' || latest?.status === 'running';
  const waitingOnGithub = latest?.delivery?.state === 'queued' && !latest.delivery.configured;
  const publishing = (latest?.delivery?.state === 'queued' && !waitingOnGithub) || latest?.delivery?.state === 'publishing';
  const owner = project.role === 'owner';
  const canRecordEvidence = owner && project.status === 'active' && !task.archivedAt && task.status === 'REVIEW'
    && !latest?.review && latest?.artifact;
  const checkingQa = latest?.qa?.state === 'queued' || latest?.qa?.state === 'running';
  const canManageQa = owner && project.status === 'active' && task.status === 'TESTING';
  const awaitingChecks = task.status === 'TESTING' && latest?.status === 'succeeded' && !latest.report;
  const revising = task.status === 'REJECTED' && latest?.review?.decision === 'rejected' && latest.report?.passed;
  const pendingDecisions = task.decisions?.filter(({ answer }) => !answer) ?? [];
  const needsRevisionArtifact = revising || (latest?.revision && (task.status !== 'READY' || task.decisions?.length));
  const canStart = owner && project.status === 'active' && !task.archivedAt && task.repositoryId
    && (['READY', 'FAILED', 'TIMEOUT'].includes(task.status) || revising || (awaitingChecks && hasChecks))
    && (!pendingDecisions.length || task.status === 'READY');
  const candidates = workersResult.data?.filter(({ status, capabilities }) =>
    status !== 'disabled' && Boolean(capabilities?.codexVersion)
    && (!hasChecks || capabilities?.verificationVersion === 1)
    && (!needsRevisionArtifact || capabilities?.revisionArtifactVersion === 1)
    && (!needsMaven || capabilities?.mavenVerification === true)
    && (!hasChecks || (!autoDraftPr && !planned && !scheduledIndependent.length) || capabilities?.artifactVersion === 1));
  const waitingForMaven = candidates && latest?.status === 'queued' && needsMaven
    && !candidates.some(({ id, status, capabilities }) =>
      status === 'online' && capabilities && !workerDiskPressure(capabilities)
      && (!latest.requestedWorkerId || latest.requestedWorkerId === id));
  const workerName = (id: string) => workers.find((worker) => worker.id === id)?.name ?? id.slice(0, 8);
  const dispatchLabel = revising ? '派发修订' : task.status === 'READY' ? '派发任务' : '重试执行';
  const publishLabel = latest?.delivery ? '重试发布' : '发布分支并创建草稿 PR';
  const identity = <>
    <input type="hidden" name="projectId" value={project.id} />
    <input type="hidden" name="taskId" value={task.id} />
    {approvals && <input type="hidden" name="section" value="approvals" />}
  </>;

  const refreshing = active || publishing || (checkingQa && project.status === 'active');
  const independentEvidence = gate && canRecordEvidence && (latest.evidence ?? []).filter(entry => entry.check).length < 100;
  const canReview = latest && !latest.review && owner && project.status === 'active' && task.status === 'REVIEW' && latest.report?.passed;
  const canPublish = latest && owner && project.status === 'active' && task.status === 'REVIEW' &&
    latest.review?.decision === 'approved' && latest.report?.passed && latest.artifact && gate?.ready !== false &&
    (!latest.delivery || latest.delivery.state === 'failed');
  const canAssign = owner && project.status === 'active' && latest?.status === 'queued';
  const canRetryQa = latest && canManageQa && latest.qa?.state === 'failed';
  const stream = latest && (eventsResult?.issue
    ? <SectionReadError label="运行记录" issue={eventsResult.issue} />
    : <TaskActivity key={latest.id} title="运行记录" items={[...(events ?? [])].reverse().map(executionActivity)} live={refreshing} />);

  return <section aria-labelledby="execution-heading" className="execution-block">
    {refreshing && <RefreshExecution />}
    <div className="task-detail__card execution-summary">
      <header className="execution-head">
        <div>
          <h4 id="execution-heading">Codex 执行</h4>
          <p>{latest ? <>执行 <code>{latest.id.slice(0, 8)}</code>{' · '}
            <time dateTime={latest.createdAt}>{new Date(latest.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</time></>
            : '暂无执行记录。'}</p>
        </div>
        {latest && <span role="status" className="badge" data-status={latest.status}>{latest.cancelRequested && active ? '正在取消'
          : latest.status === 'succeeded' && latest.report?.passed ? '检查已通过' : stateLabels[latest.status]}</span>}
      </header>
      {latest && (latest.requestedWorkerId || latest.workerId || latest.qa || latest.delivery) && <dl className="execution-summary__facts">
        {latest.requestedWorkerId && <div><dt>指定 Worker</dt><dd>{workerName(latest.requestedWorkerId)}</dd></div>}
        {latest.workerId && <div><dt>领取 Worker</dt><dd>{workerName(latest.workerId)}</dd></div>}
        {latest.qa && <div><dt>QA</dt><dd>{qaLabels[latest.qa.state]}</dd></div>}
        {latest.delivery && <div><dt>交付</dt><dd>{waitingOnGithub ? '等待 GitHub App 配置' : deliveryLabels[latest.delivery.state]}</dd></div>}
      </dl>}
      {workersResult.issue && <SectionReadError label="执行 Worker 列表" issue={workersResult.issue} />}
      {waitingForMaven && <p className="feedback">当前分配范围内没有可领取任务的 Maven Worker。</p>}
      {owner && awaitingChecks && !hasChecks && <p className="muted">配置仓库检查计划后可重新派发。</p>}
      {(canStart || canAssign || canRetryQa || canReview || canPublish || independentEvidence) &&
        <div className="execution-actions" role="group" aria-label="执行操作">
          {canStart && <ActionDialog title={dispatchLabel} actionKey="dispatch" className="task-detail__cta" renderClosed>
            {pendingDecisions.length > 0 ? <div className="fields">
              <p className="warning-text">请在任务详情补充以下决策并重新送审。</p>
              <ul>{pendingDecisions.map(({ id, question }) => <li key={id}>{question}</li>)}</ul>
            </div> : <form action={startExecution} className="fields">
              {identity}{revising && <input type="hidden" name="revisionOf" value={latest.id} />}
              <WorkerChoice workers={candidates} />
              <SubmitButton pendingLabel="正在请求派发…">{revising ? '按驳回意见派发修订' : dispatchLabel}</SubmitButton>
            </form>}
          </ActionDialog>}
          {independentEvidence && <ActionDialog title="登记独立复验" actionKey="independent-evidence"
            className={gate.ready ? undefined : 'task-detail__cta'} renderClosed>
            <form action={addExecutionEvidence} className="fields" aria-label="登记独立复验">
              {identity}<input type="hidden" name="runId" value={latest.id} />
              <input type="hidden" name="patchHash" value={canRecordEvidence.sha256} />
              <label>复验项目<select name="checkName" required defaultValue="">
                <option value="" disabled>选择检查</option>
                {gate.checks.map(({ name }) => <option key={name} value={name}>{name}</option>)}
              </select></label>
              <label>独立复验结果<select name="checkStatus" required defaultValue="">
                <option value="" disabled>选择结果</option>
                {independentCheckStatuses.map(status => <option key={status} value={status}>{checkLabels[status]}</option>)}
              </select></label>
              <label>执行环境<input name="environment" maxLength={200} required /></label>
              <label>报告摘要<textarea name="summary" maxLength={2000} required /></label>
              <label>报告链接（可选）<input type="url" name="url" maxLength={1000} /></label>
              <p>结果须来自对当前归档的独立复验。</p>
              <SubmitButton pendingLabel="正在登记…">登记独立复验</SubmitButton>
            </form>
          </ActionDialog>}
          {canReview && <ActionDialog title="人工审核" actionKey="review"
            className={independentEvidence && !gate?.ready ? undefined : 'task-detail__cta'} renderClosed>
            <form action={reviewExecution} className="fields">
              {identity}<input type="hidden" name="runId" value={latest.id} />
              {autoDraftPr && latest.artifact && <p>批准变更后将自动发布分支并创建草稿 PR。</p>}
              <label>审核意见<textarea name="comment" maxLength={1500} placeholder="驳回时请填写原因" /></label>
              <div className="inline-fields">
                <SubmitButton name="decision" value="approved" pendingLabel="正在提交…" disabled={gate?.ready === false}>批准变更</SubmitButton>
                <SubmitButton name="decision" value="rejected" className="secondary" pendingLabel="正在提交…">驳回变更</SubmitButton>
              </div>
            </form>
          </ActionDialog>}
          {canPublish && <ActionDialog title={publishLabel} actionKey="publish" className="task-detail__cta">
            <form action={publishExecution} className="fields">
              {identity}<input type="hidden" name="runId" value={latest.id} />
              <SubmitButton pendingLabel="正在请求发布…">{publishLabel}</SubmitButton>
            </form>
          </ActionDialog>}
          {canRetryQa && <form action={retryExecutionQa}>
            {identity}<input type="hidden" name="runId" value={latest.id} />
            <SubmitButton pendingLabel="正在重试…">重试 QA</SubmitButton>
          </form>}
          {canAssign && <ActionDialog title="调整 Worker 分配" actionKey="worker-assignment">
            <form action={changeExecutionWorker} className="fields">
              {identity}<input type="hidden" name="runId" value={latest.id} />
              <WorkerChoice key={latest.requestedWorkerId} workers={candidates} selected={latest.requestedWorkerId} />
              <SubmitButton pendingLabel="正在更新…">更新分配</SubmitButton>
            </form>
          </ActionDialog>}
        </div>}
      {(latest?.threadId || latest?.revision) && <details className="execution-summary__metadata">
        <summary>运行参数</summary>
        {latest.threadId && <p>线程 ID <code>{latest.threadId}</code></p>}
        {latest.revision && <><p>修订来源 · 执行 {latest.revision.runId.slice(0, 8)} · 补丁{' '}
          <code title={latest.revision.patchHash}>{latest.revision.patchHash.slice(0, 12)}</code></p>
          <p className="description">{latest.revision.reason}</p></>}
      </details>}
    </div>

    {stream}
    {latest && <>
      {gate && <section aria-labelledby="quality-gate-heading" className="task-detail__card execution-quality">
        <header className="execution-head">
          <h5 id="quality-gate-heading">质量门禁</h5>
          <span className="badge" data-status={gate.ready ? 'succeeded' : 'queued'}>{gate.ready ? '可审批' : '待复验'}</span>
        </header>
        <p role="status">{gate.ready ? '规定的检查已通过，可以审批。' : '必需检查尚未通过。'}</p>
        {!gate.workerReady && <p className="muted">等待匹配当前归档的 Worker 检查通过。</p>}
        <ul className="check-list">{gate.checks.map(check => <li key={check.name} data-status={check.status}>
          <span>{check.name}</span><small>{check.status === 'missing' ? '待登记' : checkLabels[check.status]}</small>
        </li>)}</ul>
      </section>}
      {latest.report && <section className="task-detail__card report-block">
        <header className="execution-head">
          <h5>第 {latest.report.attempt} 次检查报告</h5>
          {latest.artifact && <a className="linkbtn" href={`/artifacts/${project.id}/${task.id}/${latest.id}`}>
            下载受测补丁 · {Math.ceil(latest.artifact.size / 1024)} KB
          </a>}
        </header>
        <CheckResults checks={latest.report.checks} />
        {earlierChecks?.map(({ sequence, payload }) => Array.isArray(payload.checks) && <details key={sequence}>
          <summary>第 {String(payload.attempt)} 次检查报告</summary>
          <CheckResults checks={payload.checks as CheckResult[]} />
        </details>)}
      </section>}
      {latest.artifact && !latest.report && <p className="task-detail__card">
        <a href={`/artifacts/${project.id}/${task.id}/${latest.id}`}>下载受测补丁</a>
        {' '}<small>{Math.ceil(latest.artifact.size / 1024)} KB</small>
      </p>}
      {latest.qa && <section className="task-detail__card qa-block">
        <header className="execution-head">
          <h5>QA Agent · v{latest.qa.version}</h5>
          <span className="badge" data-status={latest.qa.state}>{qaLabels[latest.qa.state]}</span>
        </header>
        {latest.qa.assessment && <p><strong>{qaRecommendations[latest.qa.assessment.recommendation]}</strong></p>}
        <details>
          <summary>查看 QA 报告</summary>
          <p className="muted">{latest.qa.model}{latest.qa.partialPatch && ' · 审查范围为补丁开头的 64 KiB'}</p>
          {latest.qa.assessment && <>
            <ul>{latest.qa.assessment.findings.map((text, index) => <li key={index}>{text}</li>)}</ul>
            <h5>建议验证用例</h5>
            <ul>{latest.qa.assessment.testCases.map((text, index) => <li key={index}>{text}</li>)}</ul>
          </>}
        </details>
      </section>}
      {(Boolean(latest.evidence?.length) || canRecordEvidence) && <section className="task-detail__card">
        <h5>复验证据</h5>
        <EvidenceList entries={latest.evidence} />
        {canRecordEvidence && (latest.evidence ?? []).filter(entry => !entry.check).length < 10 && <ActionDialog title="添加复验证据" actionKey="evidence">
          <form action={addExecutionEvidence} className="fields">
            {identity}<input type="hidden" name="runId" value={latest.id} />
            <input type="hidden" name="patchHash" value={canRecordEvidence.sha256} />
            <label>复验结果<textarea name="summary" required maxLength={2000} /></label>
            <label>证据链接（可选）<input type="url" name="url" maxLength={1000} /></label>
            <SubmitButton pendingLabel="正在保存…">保存复验证据</SubmitButton>
          </form>
        </ActionDialog>}
      </section>}
      {latest.review && <section className="task-detail__card">
        <h5>人工审核</h5>
        <p>{latest.review.decision === 'approved' ? '已批准' : '已驳回'} · {latest.review.reviewer}</p>
        {latest.review.comment && <p className="description">{latest.review.comment}</p>}
      </section>}
      {latest.delivery && <section className="task-detail__card">
        <h5>交付</h5>
        <p role="status">{waitingOnGithub ? '等待 GitHub App 配置' : deliveryLabels[latest.delivery.state]}
          {latest.delivery.pullState && ` · ${pullLabels[latest.delivery.pullState]}`}</p>
        <p className="description">{latest.delivery.branch} → {latest.delivery.baseBranch}</p>
        {latest.delivery.pullUrl && <p><a href={latest.delivery.pullUrl}>查看 GitHub PR #{latest.delivery.pullNumber}</a></p>}
        {owner && project.status === 'active' && latest.delivery.state === 'published' && latest.delivery.pullState !== 'merged' &&
          <form action={refreshDelivery}>
            {identity}<input type="hidden" name="runId" value={latest.id} />
            <SubmitButton className="secondary" pendingLabel="正在同步…">同步 GitHub PR 状态</SubmitButton>
          </form>}
        {latest.delivery.error && <p className="feedback">{deliveryErrors[latest.delivery.error] ?? '发布失败，请重试。'}</p>}
      </section>}
      {runs.length > 1 && <details className="drawer execution-history">
        <summary><span>较早的执行</span><small>{runs.length - 1} 条</small></summary>
        <ul className="member-list">{runs.slice(1).map((run) => <li key={run.id}>
          <div><span>执行 {run.id.slice(0, 8)} · {stateLabels[run.status]}</span>
            {run.failure && <p>{executionFailureLabels[run.failure.code] ?? '执行失败，原因未记录'}</p>}
            {run.review && <p>{run.review.decision === 'rejected' ? '已驳回' : '已批准'} · {run.review.reviewer}</p>}
            {run.review?.comment && <p className="description">{run.review.comment}</p>}
            {run.artifact && <p><a href={`/artifacts/${project.id}/${task.id}/${run.id}`}>下载补丁 {run.artifact.sha256.slice(0, 12)}</a></p>}
            <EvidenceList entries={run.evidence} />
          </div><time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</time>
        </li>)}</ul>
      </details>}
    </>}
  </section>;
}
