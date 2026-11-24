import Link from 'next/link';
import { agentRoleLabels, canTransitionTask, developerRoles, taskPriorities, type Project, type RepositoryBinding, type Task,
  type AgentPlan, type AgentRegistry, type ExecutionRun, type TaskDetail, type TaskEvent, type TaskStatus } from '@ado/shared';
import { archiveTask, saveTask, stopExecution, submitTaskDecisions, transitionTask } from './actions';
import { PlanProgress } from './agents';
import { readSection, type ReadIssue } from './api-client';
import { Executions } from './executions';
import { SectionReadError } from './section-feedback';
import { SubmitButton } from './task-feedback';
import { TaskRequirements } from './task-requirements';

import { ActionDialog, TaskDrawer } from './console-controls';
import { Metric } from './dashboard';
import { Icon } from './icons';
import { TaskBoard } from './task-board';
import { TaskActivity, type ActivityItem } from './task-activity';
import { TaskDetailTabs, type TaskDetailTab } from './task-detail-tabs';
import { taskFailureLabel, taskStatusLabels as statusLabels, workspaceHref } from './workspace';

const taskActions: { status: TaskStatus; label: string; ownerOnly?: boolean }[] = [
  { status: 'PLANNING', label: '进入规划' },
  { status: 'WAITING_APPROVAL', label: '提交审批' },
  { status: 'READY', label: '批准方案', ownerOnly: true },
  { status: 'REJECTED', label: '驳回方案', ownerOnly: true },
  { status: 'CANCELLED', label: '取消任务' },
];
const editable = ['CREATED', 'PLANNING', 'BLOCKED', 'REJECTED'];
const canManageStates = [...editable, 'WAITING_APPROVAL', 'READY', 'FAILED', 'TIMEOUT'];
const eventLabels: Record<string, string> = {
  'task.created': '创建任务', 'task.updated': '编辑任务', 'task.archived': '归档任务',
  'task.auto_approval_succeeded': '自动审批成功',
  'task.auto_approval_pending_delivery': '自动审批待交付',
  'task.auto_approval_failed': '自动审批失败',
  'task.status_changed': '任务状态更新',
  'task.decisions_submitted': '补充决策并送审',
  'agent.plan_queued': 'Agent 规划入队', 'agent.plan_started': 'Agent 规划开始',
  'agent.model_usage': '模型用量', 'agent.step_completed': '规划步骤完成',
  'agent.plan_version_ready': '方案版本可送审', 'agent.plan_version_approved': '方案版本已批准',
  'agent.plan_failed': '规划失败', 'agent.plan_cancelled': '规划取消',
};

function eventStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && Object.hasOwn(statusLabels, value);
}

function taskActivity(event: TaskEvent): ActivityItem {
  const { to, from } = event.payload;
  if (event.eventType === 'task.delivery_closed') {
    const { outcome, reason, pullNumber, originalCommitSha, finalCommitSha, mergeSha } = event.payload;
    const committed = typeof originalCommitSha === 'string' && typeof finalCommitSha === 'string' && typeof mergeSha === 'string';
    return {
      id: event.id, at: event.createdAt, group: '交付', label: outcome === 'completed' ? '确认交付并结案' : '取消并归档',
      detail: committed ? ['PR #' + String(pullNumber), '原审批 ' + originalCommitSha.slice(0, 8),
        '最终提交 ' + finalCommitSha.slice(0, 8), '合并 ' + mergeSha.slice(0, 8)].join(' · ')
        : typeof reason === 'string' ? reason : undefined,
    };
  }
  const version = event.payload.planVersion ?? event.payload.version;
  const commit = event.payload.planCommit ?? event.payload.commit;
  const versionDetail = typeof version === 'string' && typeof commit === 'string'
    ? `方案 ${version.slice(0, 8)} · 提交 ${commit.slice(0, 12)}` : undefined;
  const planning = event.eventType.startsWith('agent.');
  const failed = ['FAILED', 'TIMEOUT', 'BLOCKED', 'REJECTED'].includes(String(to)) || event.eventType.endsWith('_failed');
  return {
    id: event.id, at: event.createdAt,
    label: to === 'READY' ? '批准方案 · 待派发' : eventStatus(to) ? statusLabels[to] : eventLabels[event.eventType] ?? event.eventType,
    group: failed ? '异常' : planning ? '规划' : eventStatus(to) ? '状态' : '任务',
    tone: failed ? 'rose' : undefined,
    detail: versionDetail ?? (eventStatus(from) && eventStatus(to) ? `${statusLabels[from]} → ${statusLabels[to]}` : undefined),
  };
}

function shortCode(code: string) {
  return code.length > 20 ? `${code.slice(0, 8)}…${code.slice(-4)}` : code;
}

function TaskForm({ projectId, task, tasks, repositories }: {
  projectId: string;
  task?: TaskDetail;
  tasks: Task[];
  repositories: RepositoryBinding[];
}) {
  const choices = tasks.filter(({ id }) => id !== task?.id);
  return (
    <form className="fields" action={saveTask}>
      <input type="hidden" name="projectId" value={projectId} />
      {task ? <input type="hidden" name="taskId" value={task.id} /> :
        <label>任务编号<input name="code" maxLength={50} required /></label>}
      <label>任务标题<input name="title" defaultValue={task?.title} maxLength={255} required /></label>
      <label>任务说明<textarea name="description" defaultValue={task?.description} maxLength={12000} required /></label>
      <label>验收条件（每行一条）<textarea name="acceptanceCriteria" defaultValue={task?.acceptanceCriteria.join('\n')} /></label>
      <div className="field-row">
        <label>优先级<select name="priority" defaultValue={task?.priority ?? 'P1'}>
          {taskPriorities.map((priority) => <option key={priority}>{priority}</option>)}
        </select></label>
        <label>仓库<select name="repositoryId" defaultValue={task?.repositoryId ?? ''}>
          <option value="">暂未选择</option>
          {repositories.map(({ id, fullName }) => <option key={id} value={id}>{fullName}</option>)}
        </select></label>
      </div>
      {choices.length > 0 && <>
        <label>父任务<select name="parentTaskId" defaultValue={task?.parentTaskId ?? ''}>
          <option value="">无</option>
          {choices.map(({ id, code, title }) => <option key={id} value={id}>{code} · {title}</option>)}
        </select></label>
        <fieldset className="check-grid">
          <legend>前置任务</legend>
          {choices.map(({ id, code, title }) => (
            <label className="check-item" key={id}>
              <input type="checkbox" name="dependencies" value={id} defaultChecked={task?.dependencies.includes(id)} />
              <span>{code} · {title}</span>
            </label>
          ))}
        </fieldset>
      </>}
      <SubmitButton pendingLabel={task ? '正在保存…' : '正在创建…'}>{task ? '保存任务' : '创建任务'}</SubmitButton>
    </form>
  );
}

export async function Tasks({ project, tasks, repositories, selectedId, lane, create, approvals, feedback, notice, requirementResult, taskIssue, repositoryIssue, workerUnavailable }: {
  project: Project; tasks: Task[]; repositories: RepositoryBinding[]; selectedId?: string;
  lane?: string; create: boolean; approvals: boolean; feedback?: string; notice?: string;
  requirementResult?: string; taskIssue?: ReadIssue; repositoryIssue?: ReadIssue; workerUnavailable?: boolean;
}) {
  const path = `/projects/${project.id}/tasks`;
  const selected = tasks.find(({ id }) => selectedId === id);
  const canWrite = project.status === 'active' && project.role !== 'viewer';
  const [taskResult, eventResult, planResult, runsResult] = await Promise.all([
    selected ? readSection<TaskDetail>(`${path}/${selected.id}`, (data) => data.id === selected.id) : null,
    selected ? readSection<TaskEvent[]>(`${path}/${selected.id}/events`, Array.isArray) : null,
    selected ? readSection<{ plan: AgentPlan | null }>(`${path}/${selected.id}/agent-plan`, (data) => 'plan' in data) : null,
    selected ? readSection<ExecutionRun[]>(`${path}/${selected.id}/executions`, Array.isArray) : null,
  ]);
  const task = taskResult?.data;
  const events = eventResult?.data ?? [];
  const manageRequirements = project.role === 'owner' && project.status === 'active';
  const plan = planResult?.data?.plan;
  const pendingDecisions = task?.decisions?.filter(({ answer }) => !answer) ?? [];
  const confirmedDecisions = task?.decisions?.filter(({ answer }) => Boolean(answer)) ?? [];
  const failure = task && taskFailureLabel(task);
  const managedPlan = plan && ['queued', 'running', 'failed'].includes(plan.state);
  const chooseDeveloper = manageRequirements && task?.status === 'WAITING_APPROVAL' && plan?.state !== 'completed';
  const registry = chooseDeveloper ? await readSection<AgentRegistry>(`/projects/${project.id}/agent-registry`,
    data => Array.isArray(data.agents)) : null;
  const developers = developerRoles.filter((role) => registry?.data?.agents.some((agent) => agent.role === role && agent.enabled));
  const boundRepository = repositories.find(({ id }) => id === task?.repositoryId);
  const view = approvals ? 'approvals' : 'tasks';
  const viewParams: Record<string, string> = lane ? { lane } : {};
  const closeHref = workspaceHref(project.id, view, viewParams);
  const taskLink = (id: string) => workspaceHref(project.id, view, { ...viewParams, task: id });
  const labels = new Map(tasks.map(({ id, code }) => [id, code]));
  const taskIdentity = task && <>
    <input type="hidden" name="projectId" value={project.id} />
    <input type="hidden" name="taskId" value={task.id} />
    {approvals && <input type="hidden" name="section" value="approvals" />}
  </>;
  const openTasks = tasks.filter(({ archivedAt, status }) => !archivedAt && status !== 'COMPLETED' && status !== 'CANCELLED');
  const plans = tasks.filter(({ archivedAt, status }) => !archivedAt && status === 'WAITING_APPROVAL');
  const reviews = tasks.filter(({ archivedAt, status }) => !archivedAt && status === 'REVIEW');
  const available = task && canWrite && !task.archivedAt;
  const transitions = available && canManageStates.includes(task.status)
    ? taskActions.filter(({ status, ownerOnly }) => canTransitionTask(task.status, status)
      && (!managedPlan || status === 'CANCELLED') && !(plan?.proposal && status === 'PLANNING')
      && (!ownerOnly || project.role === 'owner')) : [];
  const canEdit = available && !managedPlan && !plan?.proposal && editable.includes(task.status);
  const canArchive = available && project.role === 'owner' && ['CREATED', 'CANCELLED', 'COMPLETED'].includes(task.status);
  const hasRelations = task && (task.parentTaskId || task.dependencies.length > 0);
  const latestRun = runsResult?.data?.[0];
  const canStopRun = latestRun && project.role === 'owner' && !latestRun.cancelRequested
    && (latestRun.status === 'queued' || latestRun.status === 'running');
  const canStopQa = latestRun && project.role === 'owner' && project.status === 'active' && task?.status === 'TESTING'
    && latestRun.qa && ['queued', 'running', 'failed'].includes(latestRun.qa.state);
  const stopTitle = canStopRun ? '取消执行' : '取消任务';
  const initialTab: TaskDetailTab = pendingDecisions.length || (task && ['READY', 'QUEUED', 'RUNNING', 'RETRYING', 'TESTING', 'REVIEW',
    'FAILED', 'TIMEOUT', 'BLOCKED', 'REJECTED', 'MERGED', 'COMPLETED'].includes(task.status)) ? 'execution'
    : plan && task && ['PLANNING', 'WAITING_APPROVAL'].includes(task.status) ? 'plan' : 'summary';

  return (
    <section className="task-section" aria-labelledby="tasks-heading">
      <header className="page__head">
        <div>
          <p className="eyebrow">{project.code} / {approvals ? 'APPROVALS' : 'WORK ITEMS'}</p>
          <h1 id="tasks-heading">{approvals ? '审批中心' : '任务看板'}</h1>
        </div>
        <div className="page__meta">
          {approvals ? <>
            <Metric label="待审批">{plans.length}</Metric><Metric label="评审阶段">{reviews.length}</Metric>
          </> : <>
            <Metric label="OPEN">{openTasks.length}</Metric>
            <Metric label="BLOCKED">{openTasks.filter(({ status }) => ['BLOCKED', 'FAILED', 'TIMEOUT'].includes(status)).length}</Metric>
            <Metric label="P0">{openTasks.filter(({ priority }) => priority === 'P0').length}</Metric>
          </>}
        </div>
      </header>

      {taskIssue && <SectionReadError label="项目任务" issue={taskIssue} />}
      {repositoryIssue && <SectionReadError label="任务仓库" issue={repositoryIssue} />}
      {!approvals && <div className="page-actions task-tools" id="task-requirements">
        <TaskRequirements project={project} taskId={selected?.id} result={requirementResult} repositories={repositories} canWrite={canWrite} />
      </div>}

      {approvals ? <div className="approval-grid">
        {[{ label: '待审批方案', items: plans }, { label: '评审阶段', items: reviews }].map(({ label, items }) => (
          <section className="panel" key={label}>
            <header className="panel__head"><h2 className="panel__title"><Icon name="shield" />{label}</h2>
              <span className="panel__meta">{items.length} 项</span></header>
            {items.map((item) => <Link href={taskLink(item.id)} scroll={false} className="appr" key={item.id}>
              <span className="appr__risk" data-tone={item.status === 'WAITING_APPROVAL' ? 'amber' : 'ice'} />
              <span className="appr__body"><b>{item.title}</b><small>{item.code} · {item.priority}</small></span>
              <Icon name="chevron" />
            </Link>)}
            {!items.length && <p className="empty">队列已清空。</p>}
          </section>
        ))}
      </div> : <TaskBoard key={project.id} projectId={project.id} canWrite={canWrite} lane={lane}
        items={tasks.map(({ id, code, title, status, priority, archivedAt, createdAt, executionFailure, decisions }) => ({
          id, code, title, status, priority, archivedAt, createdAt,
          failure: executionFailure?.code === 'needs_decisions' ? null : taskFailureLabel({ status, executionFailure, decisions }),
          pending: decisions?.filter(({ answer }) => !answer).length ?? 0,
        }))} />}

      {create && canWrite && !task && <TaskDrawer label="新建研发任务" closeHref={closeHref}>
        <div className="task-overlay__form">
          {feedback && <p className="feedback" role="alert">{feedback}</p>}
          <TaskForm projectId={project.id} tasks={tasks} repositories={repositories} />
        </div>
      </TaskDrawer>}



      {taskResult?.issue && <SectionReadError label="任务详情" issue={taskResult.issue} />}
      {selectedId && !selected && <p role="status" className="empty">该任务在当前项目中不可用。</p>}
      {task && runsResult && <TaskDrawer key={task.id} label={`任务详情 · ${shortCode(task.code)}`} closeHref={closeHref}
        heading={<div className="task-detail__heading">
          <div className="task-detail__identity">
            <span className="task-detail__code">{task.code}</span>
            <span className="badge" data-status={task.status}>{statusLabels[task.status]}</span>
            <span className="task-priority" data-priority={task.priority} aria-label={`优先级 ${task.priority}`}>{task.priority}</span>
            {task.archivedAt && <span className="task-priority">已归档</span>}
          </div>
          <h2>{task.title}</h2>
          <dl className="task-detail__facts" aria-label="任务信息">
            <div title="仓库">
              <dt><Icon name="git" /><span className="sr-only">仓库</span></dt>
              <dd>{boundRepository?.fullName ?? (task.repositoryId ? '详情暂不可用' : '未绑定')}</dd>
            </div>
            <div title="责任 Agent">
              <dt><Icon name="agents" /><span className="sr-only">责任 Agent</span></dt>
              <dd>{task.developer ? `${agentRoleLabels[task.developer.role]} · v${task.developer.version}` : '未分配'}</dd>
            </div>
            <div title="创建时间">
              <dt><Icon name="clock" /><span className="sr-only">创建时间</span></dt>
              <dd><time dateTime={task.createdAt}>{new Date(task.createdAt)
                .toLocaleString('zh-CN', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' })}</time></dd>
            </div>
          </dl>
          {(transitions.length > 0 || canEdit || canArchive || hasRelations || canStopRun || canStopQa) &&
            <div className="task-detail__actions" role="group" aria-label="任务操作">
              <div className="task-detail__primary">
                {transitions.filter(({ status }) => status !== 'REJECTED' && status !== 'CANCELLED').map(({ status, label }) => {
                  const blocked = status === 'READY' && pendingDecisions.length > 0;
                  if (blocked) return <button key={status} type="button" className="task-detail__cta" disabled>{label}</button>;
                  const approve = status === 'READY' && chooseDeveloper;
                  return approve ? <ActionDialog key={status} title={label} actionKey="task-approve" className="task-detail__cta">
                    <form action={transitionTask} className="fields">{taskIdentity}
                      <input type="hidden" name="confirmTransition" value="1" />
                      {developers.length ? <label>责任 Agent<select name="developerRole"
                        defaultValue={developers.includes('BACKEND_DEVELOPER') ? 'BACKEND_DEVELOPER' : developers[0]}>
                        {developers.map((role) => <option key={role} value={role}>{agentRoleLabels[role]}</option>)}
                      </select></label> : <p className="warning-text">请先启用开发 Agent。</p>}
                      <SubmitButton name="status" value={status} pendingLabel="正在批准…" disabled={!developers.length}>{label}</SubmitButton>
                    </form>
                  </ActionDialog> : <form key={status} action={transitionTask}>{taskIdentity}
                    {status === 'READY' && plan?.proposal && <input type="hidden" name="planVersion" value={plan.proposal.version} />}
                    <SubmitButton name="status" value={status} pendingLabel="正在提交…">{label}</SubmitButton>
                  </form>;
                })}
              </div>
              <div className="task-detail__secondary">
                {hasRelations && <ActionDialog title="关联任务">
                  <div className="task-detail__relations">
                    {task.parentTaskId && <div><strong>父任务</strong><Link href={taskLink(task.parentTaskId)}>
                      {labels.get(task.parentTaskId) ?? shortCode(task.parentTaskId)}</Link></div>}
                    {task.dependencies.length > 0 && <div><strong>前置任务</strong>{task.dependencies.map((id) => (
                      <Link key={id} href={taskLink(id)}>{labels.get(id) ?? shortCode(id)}</Link>
                    ))}</div>}
                  </div>
                </ActionDialog>}
                {canEdit && <ActionDialog title="编辑任务" actionKey="task-edit">
                  <TaskForm projectId={project.id} task={task} tasks={tasks} repositories={repositories} />
                </ActionDialog>}
                {transitions.filter(({ status }) => status === 'REJECTED' || status === 'CANCELLED').map(({ status, label }) => (
                  <ActionDialog key={status} title={label} actionKey={status === 'REJECTED' ? 'task-reject' : 'task-cancel'}
                    className={status === 'CANCELLED' ? 'utility-btn task-detail__cancel' : undefined}>
                    <form action={transitionTask} className="fields">{taskIdentity}
                      <input type="hidden" name="confirmTransition" value="1" />
                      <p>{status === 'REJECTED' ? '驳回后，任务会退回规划流程。' : '取消后，任务将结束当前流程。'}</p>
                      <div className="form-actions">
                        <SubmitButton name="status" value={status} className="btn-danger" pendingLabel="正在提交…">确认{label}</SubmitButton>
                      </div>
                    </form>
                  </ActionDialog>
                ))}
                {canArchive && <ActionDialog title="归档任务" actionKey="task-archive">
                  <form action={archiveTask} className="fields">{taskIdentity}
                    <p>归档后可通过「显示已归档」查看。</p>
                    <div className="form-actions"><SubmitButton className="btn-danger" pendingLabel="正在归档…">确认归档</SubmitButton></div>
                  </form>
                </ActionDialog>}
                {(canStopRun || canStopQa) && <ActionDialog title={stopTitle} actionKey="execution-stop" className="utility-btn task-detail__cancel">
                  <form action={stopExecution} className="fields">
                    {taskIdentity}<input type="hidden" name="runId" value={latestRun.id} />
                    <p>{canStopRun ? '取消后将停止当前执行，已产生的记录仍可查看。' : '取消后将结束当前验收流程。'}</p>
                    <SubmitButton className="btn-danger" pendingLabel="正在请求取消…">确认取消</SubmitButton>
                  </form>
                </ActionDialog>}
              </div>
            </div>}
        </div>}>
        <article id="task-detail" className="task-detail" tabIndex={-1}>
          {(feedback || workerUnavailable || registry?.issue || notice) && <div className="task-detail__feedback">
            {feedback && <p className="feedback" role="alert">{feedback}</p>}
            {workerUnavailable && <p className="feedback" role="status">暂无符合条件的在线 Worker</p>}
            {registry?.issue && <SectionReadError label="责任 Agent" issue={registry.issue} />}
            {notice && <p className="notice" role="status">{notice}</p>}
          </div>}

          <TaskDetailTabs initialTab={initialTab} panels={{
            summary: <div id="task-summary" className="task-detail__brief">
              <section className="task-detail__card">
                <h3>任务说明</h3><p className="description">{task.description}</p>
              </section>
              <section className="task-detail__card">
                <h3>验收条件 <small>{task.acceptanceCriteria.length} 项</small></h3>
                {task.acceptanceCriteria.length > 0 ? <ol className="criterion-list">{task.acceptanceCriteria.map((criterion, index) =>
                  <li key={index}><span aria-hidden="true">{index + 1}</span>{criterion}</li>)}</ol>
                  : <p className="muted">暂无验收条件。</p>}
              </section>
            </div>,
            plan: <div id="task-plan">
              {planResult?.issue ? <SectionReadError label="Agent 规划" issue={planResult.issue} />
                : plan ? <PlanProgress projectId={project.id} plan={plan} showDiagnosis={project.role === 'owner'}
                  canRetry={canWrite && !task.archivedAt && task.status === 'PLANNING'}
                  canRefresh={manageRequirements && !task.archivedAt && ['WAITING_APPROVAL', 'READY', 'FAILED', 'REJECTED', 'TIMEOUT'].includes(task.status)} />
                  : <p className="task-detail__empty">此任务暂无 Agent 规划。</p>}
            </div>,
            execution: <div className="execution-block">
              {failure && <p className="feedback" role="status"><strong>执行结果</strong> · {failure}</p>}
              {(pendingDecisions.length > 0 || confirmedDecisions.length > 0) &&
                <section id="task-decisions" className="task-detail__card decision-review" aria-labelledby="decision-heading">
                  <h4 id="decision-heading">{pendingDecisions.length ? '待人工确认' : '已记录的人工决策'}</h4>
                  {confirmedDecisions.length > 0 && <dl className="decision-answers">{confirmedDecisions.map(({ id, question, answer }) =>
                    <div key={id}><dt>{question}</dt><dd>{answer}</dd></div>)}</dl>}
                  {pendingDecisions.length > 0 && <>
                    <p className="warning-text">{plan?.reviewStatus ? '提交决定后，规划 Agent 将修订方案并复核受影响的内容。'
                      : '请明确以下事项并送审。项目所有者批准后才能派发。'}</p>
                    {(plan?.reviewStatus ? manageRequirements && ['PLANNING', 'FAILED'].includes(task.status)
                      : canWrite && ['WAITING_APPROVAL', 'READY', 'FAILED'].includes(task.status)) && !task.archivedAt
                      ? <form action={submitTaskDecisions} className="fields">
                        {taskIdentity}
                        {pendingDecisions.map(({ id, question, options, impact }, index) => <div className="decision-question" key={id}>
                          <label>{question}
                            <input name={`decision:${id}`} list={`decision-options-${index}`}
                              aria-describedby={`decision-recommendation-${index}`} autoComplete="off"
                              placeholder="选择建议或填写具体决定" maxLength={1000} pattern={'.*\\S.*'} required={!plan?.reviewStatus} />
                          </label>
                          <datalist id={`decision-options-${index}`}>{options.map((option) => <option key={option} value={option} />)}</datalist>
                          <p className="muted" id={`decision-recommendation-${index}`}>推荐 · {options[0]}</p>
                          {impact && <p className="muted">{impact}</p>}
                          <ul>{options.map((option) => <li key={option}>{option}</li>)}</ul>
                        </div>)}
                        <div className="form-actions"><SubmitButton pendingLabel="正在提交…">{plan?.reviewStatus ? '提交决定' : '补充决策并重新送审'}</SubmitButton></div>
                      </form>
                      : <ul>{pendingDecisions.map(({ id, question, options, impact }) =>
                        <li key={id}><strong>{question}</strong><p>推荐 · {options[0]}</p>{impact && <p>{impact}</p>}
                          <ul>{options.map((option) => <li key={option}>{option}</li>)}</ul></li>)}</ul>}
                  </>}
                </section>}
              <Executions project={project} task={task} runsResult={runsResult}
                checks={boundRepository?.checks ?? []} independentChecks={boundRepository?.independentChecks ?? []}
                autoDraftPr={boundRepository?.autoDraftPr === true} planned={plan?.state === 'completed'} approvals={approvals} />
            </div>,
            activity: <div id="task-events">
              {eventResult?.issue ? <SectionReadError label="任务活动" issue={eventResult.issue} />
                : <TaskActivity title="任务活动" items={[...events].reverse().map(taskActivity)} />}
            </div>,
          }} />
        </article>
      </TaskDrawer>}
    </section>
  );
}
