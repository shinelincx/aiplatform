import Link from 'next/link';
import { Suspense } from 'react';
import { agentRoleLabels, canTransitionTask, developerRoles, taskPriorities, type Project, type RepositoryBinding, type Task,
  type AgentPlan, type AgentRegistry, type TaskDetail, type TaskEvent, type TaskStatus } from '@ado/shared';
import { archiveTask, saveTask, transitionTask } from './actions';
import { PlanProgress } from './agents';
import { read, readSection } from './api-client';
import { Executions } from './executions';
import { SectionReadError } from './section-feedback';
import { ActionFeedback, SubmitButton, TaskDetailFocus } from './task-feedback';
import { TaskRequirements } from './task-requirements';

const statusLabels: Record<TaskStatus, string> = {
  CREATED: '草稿', PLANNING: '规划中', WAITING_APPROVAL: '待审批', READY: '待派发', QUEUED: '排队中',
  RUNNING: '执行中', TESTING: '测试中', REVIEW: '待评审', MERGED: '已合并', COMPLETED: '已完成',
  BLOCKED: '已阻塞', FAILED: '失败', TIMEOUT: '超时', CANCELLED: '已取消', REJECTED: '已驳回', RETRYING: '重试中',
};

const taskActions: { status: TaskStatus; label: string; ownerOnly?: boolean }[] = [
  { status: 'PLANNING', label: '进入规划' },
  { status: 'WAITING_APPROVAL', label: '提交审批' },
  { status: 'READY', label: '批准方案', ownerOnly: true },
  { status: 'REJECTED', label: '驳回方案', ownerOnly: true },
  { status: 'CANCELLED', label: '取消任务' },
];
const taskNotices = new Map([
  ['task-created', '研发任务已创建。'],
  ['task-transitioned', '任务状态已更新。'],
  ['execution-requested', '已提交派发请求，请查看执行状态。'],
  ['execution-reviewed', '执行评审结果已提交。'],
  ['execution-evidence-saved', '复验证据已保存。'],
]);

const editable = ['CREATED', 'PLANNING', 'BLOCKED', 'REJECTED'];
const canManageStates = [...editable, 'WAITING_APPROVAL', 'READY', 'FAILED', 'TIMEOUT'];

function TaskForm({ projectId, task, tasks, repositories }: {
  projectId: string;
  task?: TaskDetail;
  tasks: Task[];
  repositories?: RepositoryBinding[];
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
      <label>优先级<select name="priority" defaultValue={task?.priority ?? 'P1'}>
        {taskPriorities.map((priority) => <option key={priority}>{priority}</option>)}
      </select></label>
      <label>仓库<select name="repositoryId" defaultValue={task?.repositoryId ?? ''}>
        <option value="">暂未选择</option>
        {!repositories && task?.repositoryId && <option value={task.repositoryId}>保留当前仓库</option>}
        {repositories?.map(({ id, fullName }) => <option key={id} value={id}>{fullName}</option>)}
      </select></label>
      {choices.length > 0 && <>
        <label>父任务<select name="parentTaskId" defaultValue={task?.parentTaskId ?? ''}>
          <option value="">无</option>
          {choices.map(({ id, code, title }) => <option key={id} value={id}>{code} · {title}</option>)}
        </select></label>
        <fieldset>
          <legend>前置任务</legend>
          {choices.map(({ id, code, title }) => (
            <label className="checkbox" key={id}>
              <input type="checkbox" name="dependencies" value={id} defaultChecked={task?.dependencies.includes(id)} />
              {code} · {title}
            </label>
          ))}
        </fieldset>
      </>}
      <SubmitButton pendingLabel={task ? '正在保存…' : '正在创建…'}>{task ? '保存任务' : '创建任务'}</SubmitButton>
    </form>
  );
}

export async function Tasks({ project, selectedId, requirementResult, notice }: {
  project: Project;
  selectedId?: string;
  requirementResult?: string;
  notice?: string;
}) {
  const noticeMessage = notice ? taskNotices.get(notice) : undefined;
  const path = `/projects/${project.id}/tasks`;
  const taskList = await read<Task[]>(path).catch(() => null);
  const tasks = taskList ?? [];
  const selected = tasks.find(({ id }) => selectedId === id);
  const canWrite = project.status === 'active' && project.role !== 'viewer';
  const [task, events, repositoryResult, planning] = await Promise.all([
    selected ? read<TaskDetail>(`${path}/${selected.id}`).catch(() => null) : null,
    selected ? read<TaskEvent[]>(`${path}/${selected.id}/events`).catch(() => null) : null,
    canWrite ? readSection<RepositoryBinding[]>(`/projects/${project.id}/repositories`, Array.isArray) : null,
    selected ? read<{ plan: AgentPlan | null }>(`${path}/${selected.id}/agent-plan`).catch(() => null) : null,
  ]);
  const manageRequirements = project.role === 'owner' && project.status === 'active';
  const plan = planning?.plan;
  const managedPlan = plan && ['queued', 'running', 'failed'].includes(plan.state);
  const chooseDeveloper = manageRequirements && task?.status === 'WAITING_APPROVAL' && plan?.state !== 'completed';
  const registry = chooseDeveloper ? await readSection<AgentRegistry>(`/projects/${project.id}/agent-registry`,
    (data) => Array.isArray(data.agents)) : null;
  const developers = developerRoles.filter((role) => registry?.data?.agents.some((agent) => agent.role === role && agent.enabled));
  const repositories = repositoryResult?.data;
  const boundRepository = repositories?.find(({ id }) => id === task?.repositoryId);
  const taskLink = (id: string) => `/?project=${project.id}&task=${id}#task-detail`;
  const labels = new Map(tasks.map(({ id, code }) => [id, code]));
  const taskIdentity = task && <>
    <input type="hidden" name="projectId" value={project.id} />
    <input type="hidden" name="taskId" value={task.id} />
  </>;
  return (
    <section id="tasks" className="panel task-section" aria-labelledby="tasks-heading">
      <h2 id="tasks-heading">任务动态</h2>
      {noticeMessage && <ActionFeedback message={noticeMessage} />}
      {!taskList ? <p className="feedback" role="alert">无法加载任务列表，请刷新后重试。</p>
        : tasks.length === 0 ? <p className="muted">项目尚无研发任务。</p>
        : <p className="muted">{tasks.filter(({ archivedAt }) => !archivedAt).length} 项未归档 · {tasks.filter(({ status }) => status === 'COMPLETED').length} 项已完成</p>}
      {selectedId && !task && <p className="feedback" role="alert">无法读取任务详情，请返回任务列表后重试。</p>}
      {repositoryResult?.issue && <SectionReadError label="任务目标仓库" issue={repositoryResult.issue} />}
      {canWrite && <details className="create-task"><summary>创建研发任务</summary>
        <TaskForm projectId={project.id} tasks={tasks} repositories={repositories} />
      </details>}
      <nav aria-label="项目任务">
        {tasks.map((item) => (
          <Link key={item.id} id={`task-row-${item.id}`} href={taskLink(item.id)} aria-current={task?.id === item.id ? 'page' : undefined}>
            <span><strong>{item.title}</strong><small>{item.code} · {item.priority}</small></span>
            <small>{item.archivedAt ? '已归档' : statusLabels[item.status]}</small>
          </Link>
        ))}
      </nav>
      <Suspense key={`${project.id}:${selectedId ?? ''}:${requirementResult ?? ''}`}
        fallback={<p role="status">正在加载需求来源…</p>}>
        <TaskRequirements project={project} taskId={selected?.id} result={requirementResult}
          repositories={repositories ?? []} canWrite={canWrite} />
      </Suspense>
      {task && <article id="task-detail" key={task.id} tabIndex={-1} aria-labelledby="task-title">
        {!noticeMessage && <TaskDetailFocus />}
        <a href={`/?project=${project.id}#task-row-${task.id}`}>返回任务列表</a>
        <h3 id="task-title">{task.code} · {task.title}</h3>
        <p className="muted">{task.priority} · {statusLabels[task.status]}{task.archivedAt && ' · 已归档'}</p>
        {task.developer && <p>责任 Agent · {agentRoleLabels[task.developer.role]} · v{task.developer.version}</p>}
        <p className="description">{task.description}</p>
        {task.acceptanceCriteria.length > 0 && <>
          <h4>验收条件</h4><ul>{task.acceptanceCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
        </>}
        {task.parentTaskId && <p>父任务 <Link href={taskLink(task.parentTaskId)}>{labels.get(task.parentTaskId)}</Link></p>}
        {task.dependencies.length > 0 && <p>前置任务 {task.dependencies.map((id) => (
          <Link key={id} href={taskLink(id)} className="task-link">{labels.get(id)}</Link>
        ))}</p>}
        {(!planning || !events) && <p className="feedback" role="alert">部分任务记录暂时无法读取，请刷新后重试。</p>}
        {plan && <PlanProgress projectId={project.id} plan={plan} showDiagnosis={project.role === 'owner'}
          canRetry={canWrite && task.status === 'PLANNING'} />}
        {canWrite && !task.archivedAt && <>
          {!managedPlan && editable.includes(task.status) && <details><summary>编辑任务</summary>
            <TaskForm projectId={project.id} task={task} tasks={tasks} repositories={repositories} />
          </details>}
          {canManageStates.includes(task.status) && <div className="inline-fields">
            {taskActions.filter(({ status, ownerOnly }) => canTransitionTask(task.status, status)
              && (!managedPlan || status === 'CANCELLED')
              && (!ownerOnly || project.role === 'owner')).map(({ status, label }) => (
              <form action={transitionTask} key={status} className={status === 'READY' && chooseDeveloper ? 'fields' : undefined}>
                {taskIdentity}
                {status === 'READY' && chooseDeveloper && (
                  developers.length ? <label>责任 Agent<select name="developerRole" defaultValue={developers.includes('BACKEND_DEVELOPER')
                    ? 'BACKEND_DEVELOPER' : developers[0]}>
                    {developers.map((role) => <option key={role} value={role}>{agentRoleLabels[role]}</option>)}
                  </select></label> : registry?.issue
                    ? <SectionReadError label="可选开发 Agent" issue={registry.issue} />
                    : <p>请先启用开发 Agent。</p>
                )}
                <SubmitButton pendingLabel="正在提交…" name="status" value={status} disabled={status === 'READY' && chooseDeveloper && !developers.length}>{label}</SubmitButton>
              </form>
            ))}
          </div>}
          {project.role === 'owner' && ['CREATED', 'CANCELLED', 'COMPLETED'].includes(task.status) &&
            <form action={archiveTask} className="repository-form">{taskIdentity}<button className="secondary">归档任务</button></form>}
        </>}
        <Executions project={project} task={task}
          checks={boundRepository?.checks ?? []} independentChecks={boundRepository?.independentChecks ?? []}
          autoDraftPr={boundRepository?.autoDraftPr === true}
          planned={plan?.state === 'completed'} />
        <details>
          <summary>任务记录</summary>
          <ol className="members">
            {events?.map(({ id, eventType, payload, createdAt }) => (
              <li key={id}>
                <span>{typeof payload.to === 'string' && Object.hasOwn(statusLabels, payload.to)
                  ? statusLabels[payload.to as TaskStatus]
                  : ({ 'task.created': '创建', 'task.updated': '编辑', 'task.archived': '归档' })[eventType] ?? eventType}</span>
                <time dateTime={createdAt}>{new Date(createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</time>
              </li>
            ))}
          </ol>
        </details>
      </article>}
    </section>
  );
}
