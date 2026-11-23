import Link from 'next/link';
import { agentRoleLabels, canTransitionTask, developerRoles, taskPriorities, type Project, type RepositoryBinding, type Task,
  type AgentPlan, type AgentRegistry, type TaskDetail, type TaskEvent, type TaskStatus } from '@ado/shared';
import { archiveTask, saveTask, transitionTask } from './actions';
import { PlanProgress } from './agents';
import { read, readSection, type ReadIssue } from './api-client';
import { Executions } from './executions';
import { SectionReadError } from './section-feedback';
import { SubmitButton } from './task-feedback';
import { TaskRequirements } from './task-requirements';

import { ActionDialog, TaskDrawer } from './console-controls';
import { Metric } from './dashboard';
import { Icon } from './icons';
import { TaskBoard } from './task-board';
import { taskStatusLabels as statusLabels, workspaceHref } from './workspace';

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
  'task.created': '创建', 'task.updated': '编辑', 'task.archived': '归档',
  'agent.plan_queued': 'Agent 规划入队', 'agent.plan_started': 'Agent 规划开始',
  'agent.model_usage': '模型用量', 'agent.step_completed': '规划步骤完成',
  'agent.plan_failed': '规划失败', 'agent.plan_cancelled': '规划取消',
};

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
  const [task, events, planning] = await Promise.all([
    selected ? read<TaskDetail>(`${path}/${selected.id}`) : null,
    selected ? read<TaskEvent[]>(`${path}/${selected.id}/events`) : null,
    selected ? read<{ plan: AgentPlan | null }>(`${path}/${selected.id}/agent-plan`).catch(() => null) : null,
  ]);
  const manageRequirements = project.role === 'owner' && project.status === 'active';
  const plan = planning?.plan;
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
  const repositoryNames = new Map(repositories.map(({ id, fullName }) => [id, fullName]));

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
      </div> : <TaskBoard projectId={project.id} canWrite={canWrite} lane={lane}
        items={tasks.map(({ id, code, title, status, priority, archivedAt, developer, repositoryId }) => ({
          id, code, title, status, priority, archivedAt,
          developerLabel: developer ? agentRoleLabels[developer.role] : undefined,
          repository: repositoryId ? repositoryNames.get(repositoryId) : undefined,
        }))} />}

      {create && canWrite && !task && <TaskDrawer label="新建研发任务" closeHref={closeHref}>
        <div className="task-overlay__form">
          {feedback && <p className="feedback" role="alert">{feedback}</p>}
          <TaskForm projectId={project.id} tasks={tasks} repositories={repositories} />
        </div>
      </TaskDrawer>}



      {selectedId && !task && <p role="status" className="empty">该任务在当前项目中不可用。</p>}
      {task && <TaskDrawer key={task.id} label={`任务详情 · ${shortCode(task.code)}`} closeHref={closeHref}>
        <article id="task-detail" className="task-detail">
          {feedback && <p className="feedback" role="alert">{feedback}</p>}
          {workerUnavailable && <p className="feedback">暂无符合条件的在线 Worker</p>}
          {registry?.issue && <SectionReadError label="责任 Agent" issue={registry.issue} />}
          {notice && <p className="notice" role="status">{notice}</p>}
          <header className="detail-head">
            <div>
              <p className="eyebrow">Task record / {shortCode(task.code)}</p>
              <h3>{task.title}</h3>
              <p className="detail-meta">
                <span>优先级 {task.priority}</span>
                {task.developer && <span>责任 Agent · {agentRoleLabels[task.developer.role]} v{task.developer.version}</span>}
                {task.archivedAt && <span>已归档</span>}
              </p>
            </div>
            <span className="badge badge--lg" data-status={task.status}>{statusLabels[task.status]}</span>
          </header>

          <nav className="detail-tabs" aria-label="任务详情导航">
            <a href="#task-summary">概览</a>
            {plan && <a href="#task-plan">规划</a>}
            <a href="#execution-heading">执行</a>
            <a href="#task-events">记录</a>
          </nav>
          <div className="detail-grid" id="task-summary">
            <section>
              <h4>任务说明</h4>
              <p className="description">{task.description}</p>
            </section>
            {task.acceptanceCriteria.length > 0 && <section>
              <h4>验收条件</h4>
              <ul className="criterion-list">{task.acceptanceCriteria.map((criterion, i) =>
                <li key={i}><span>{String(i + 1).padStart(2, '0')}</span>{criterion}</li>)}</ul>
            </section>}
          </div>

          {(task.parentTaskId || task.dependencies.length > 0) && <div className="relation-row">
            {task.parentTaskId && <p>父任务 <Link href={taskLink(task.parentTaskId)}>{labels.get(task.parentTaskId)}</Link></p>}
            {task.dependencies.length > 0 && <p>前置任务 {task.dependencies.map((id) => (
              <Link key={id} href={taskLink(id)} className="task-link">{labels.get(id)}</Link>
            ))}</p>}
          </div>}

          {plan && <div id="task-plan"><PlanProgress projectId={project.id} plan={plan} showDiagnosis={project.role === 'owner'}
            canRetry={canWrite && task.status === 'PLANNING'} /></div>}

          {canWrite && !task.archivedAt && <>
            {!managedPlan && editable.includes(task.status) && <div className="task-secondary">
              <ActionDialog title="编辑任务" actionKey="task-edit">
                <TaskForm projectId={project.id} task={task} tasks={tasks} repositories={repositories} />
              </ActionDialog>
            </div>}
            {canManageStates.includes(task.status) && <div className="action-bar">
              {taskActions.filter(({ status, ownerOnly }) => canTransitionTask(task.status, status)
                && (!managedPlan || status === 'CANCELLED')
                && (!ownerOnly || project.role === 'owner')).map(({ status, label }) => (
                <form action={transitionTask} key={status} className={status === 'READY' && chooseDeveloper ? 'fields inline-action' : 'inline-action'}>
                  {taskIdentity}
                  {status === 'READY' && chooseDeveloper && (
                    developers.length ? <label>责任 Agent<select name="developerRole" defaultValue={developers.includes('BACKEND_DEVELOPER')
                      ? 'BACKEND_DEVELOPER' : developers[0]}>
                      {developers.map((role) => <option key={role} value={role}>{agentRoleLabels[role]}</option>)}
                    </select></label> : <p className="warning-text">请先启用开发 Agent。</p>
                  )}
                  <button name="status" value={status} className={status === 'CANCELLED' ? 'btn-danger' : status === 'REJECTED' ? 'secondary' : undefined}
                    disabled={status === 'READY' && chooseDeveloper && !developers.length}>{label}</button>
                </form>
              ))}
            </div>}
            {project.role === 'owner' && ['CREATED', 'CANCELLED', 'COMPLETED'].includes(task.status) &&
              <div className="task-secondary"><ActionDialog title="归档任务" actionKey="task-archive">
                <form action={archiveTask} className="fields">{taskIdentity}
                  <p>归档后可通过「显示已归档」查看。</p>
                  <div className="form-actions"><button className="btn-danger">确认归档</button></div>
                </form>
              </ActionDialog></div>}
          </>}

          <Executions project={project} task={task}
            checks={boundRepository?.checks ?? []} independentChecks={boundRepository?.independentChecks ?? []} autoDraftPr={boundRepository?.autoDraftPr === true}
            planned={plan?.state === 'completed'} approvals={approvals} />

          <details id="task-events" className="drawer">
            <summary><span>任务记录</span><small>{events?.length ?? 0} 条</small></summary>
            <div className="drawer-body">
              <ol className="timeline">
                {events?.map(({ id, eventType, payload, createdAt }) => (
                  <li key={id}>
                    <span>{typeof payload.to === 'string' && Object.hasOwn(statusLabels, payload.to)
                      ? statusLabels[payload.to as TaskStatus]
                      : eventLabels[eventType] ?? eventType}</span>
                    <time dateTime={createdAt}>{new Date(createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</time>
                  </li>
                ))}
              </ol>
            </div>
          </details>
        </article>
      </TaskDrawer>}
    </section>
  );
}
