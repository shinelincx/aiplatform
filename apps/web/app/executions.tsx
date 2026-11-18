import type { ExecutionEvent, ExecutionRun, Project, Task } from '@ado/shared';
import { reviewExecution, startExecution, stopExecution } from './actions';
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
  repair: '根据检查结果修复', checks_changed_candidate: '测试改动了待审核补丁',
  agent_message: 'Codex 回复', command_execution: '命令执行', file_change: '文件变更',
};
function label(event: ExecutionEvent) {
  if (event.kind === 'thread') return 'Codex 线程已创建';
  if (event.kind === 'result') return '变更结果已入库';
  if (event.kind === 'verification') return `第 ${event.payload.attempt} 次检查 · ${event.payload.passed ? '通过' : '未通过'}`;
  if (event.kind === 'cancelled') return 'Worker 已取消执行';
  if (event.kind === 'item' && typeof event.payload.itemType === 'string' && Object.hasOwn(eventLabels, event.payload.itemType)) {
    return `${eventLabels[event.payload.itemType]} · ${event.payload.phase === 'started' ? '开始' : '完成'}`;
  }
  const key = event.kind === 'progress' ? event.payload.stage : event.payload.code;
  return typeof key === 'string' && Object.hasOwn(eventLabels, key) ? eventLabels[key] : '执行记录';
}

const checkLabels = { passed: '通过', failed: '失败', timed_out: '超时', unavailable: '无法运行' } as const;

export async function Executions({ project, task, hasChecks }: { project: Project; task: Task; hasChecks: boolean }) {
  const url = `/projects/${project.id}/tasks/${task.id}/executions`;
  const runs = await read<ExecutionRun[]>(url) ?? [];
  const latest = runs[0];
  const events = latest ? await read<ExecutionEvent[]>(`${url}/${latest.id}/events`) : null;
  const active = latest?.status === 'queued' || latest?.status === 'running';
  const owner = project.role === 'owner';
  const awaitingChecks = task.status === 'TESTING' && latest?.status === 'succeeded' && !latest.report;
  const canStart = owner && project.status === 'active' && !task.archivedAt && task.repositoryId
    && (['READY', 'FAILED', 'TIMEOUT'].includes(task.status) || (awaitingChecks && hasChecks));
  const identity = <>
    <input type="hidden" name="projectId" value={project.id} />
    <input type="hidden" name="taskId" value={task.id} />
  </>;

  return <section aria-labelledby="execution-heading" className="repository-form">
    <h4 id="execution-heading">Codex 执行</h4>
    {active && <RefreshExecution />}
    {canStart && <form action={startExecution}>{identity}<button>{latest ? '重试执行' : '派发任务'}</button></form>}
    {!latest && <p className="muted">暂无执行记录。</p>}
    {latest && <>
      <p role="status">{latest.cancelRequested && active ? '正在取消'
        : latest.status === 'succeeded' && latest.report?.passed ? '检查已通过' : stateLabels[latest.status]}</p>
      {owner && awaitingChecks && !hasChecks && <p className="muted">配置仓库检查计划后可重新派发。</p>}
      {latest.threadId && <p className="description">线程 ID {latest.threadId}</p>}
      {owner && active && !latest.cancelRequested && <form action={stopExecution}>
        {identity}<input type="hidden" name="runId" value={latest.id} /><button className="secondary">取消执行</button>
      </form>}
      {latest.report && <div>
        <h5>第 {latest.report.attempt} 次检查报告</h5>
        <ul className="members">{latest.report.checks.map((check) => <li key={check.name}>
          <span>{check.name} · {checkLabels[check.status]}</span>
          <small>{(check.durationMs / 1000).toFixed(2)} 秒{check.exitCode !== null && ` · 退出码 ${check.exitCode}`}</small>
        </li>)}</ul>
      </div>}
      {latest.review ? <div>
        <p>人工审核 · {latest.review.decision === 'approved' ? '已批准' : '已驳回'} · {latest.review.reviewer}</p>
        {latest.review.comment && <p className="description">{latest.review.comment}</p>}
      </div> : owner && project.status === 'active' && task.status === 'REVIEW' && latest.report?.passed
        && <form action={reviewExecution} className="fields">
          {identity}<input type="hidden" name="runId" value={latest.id} />
          <label>审核意见<textarea name="comment" maxLength={1500} placeholder="驳回时请填写原因" /></label>
          <div className="inline-fields">
            <button name="decision" value="approved">批准变更</button>
            <button name="decision" value="rejected" className="secondary">驳回变更</button>
          </div>
        </form>}
      {events?.length ? <ol className="members">
        {events.map((event) => (
          <li key={event.sequence}>
            <div><span>{label(event)}</span>
              {event.kind === 'result' && Array.isArray(event.payload.files) &&
                <ul>{event.payload.files.filter((name): name is string => typeof name === 'string')
                  .map((name, i) => <li key={i}>{name}</li>)}</ul>}
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
