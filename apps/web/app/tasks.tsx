import Link from 'next/link';
import { canTransitionTask, taskPriorities, type Project, type RepositoryBinding, type Task,
  type TaskDetail, type TaskEvent, type TaskStatus } from '@ado/shared';
import { archiveTask, saveTask, transitionTask } from './actions';
import { read } from './api-client';
import { Executions } from './executions';

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
const editable = ['CREATED', 'PLANNING', 'BLOCKED', 'REJECTED'];
const canManageStates = [...editable, 'WAITING_APPROVAL', 'READY', 'FAILED', 'TIMEOUT'];

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
      <label>优先级<select name="priority" defaultValue={task?.priority ?? 'P1'}>
        {taskPriorities.map((priority) => <option key={priority}>{priority}</option>)}
      </select></label>
      <label>仓库<select name="repositoryId" defaultValue={task?.repositoryId ?? ''}>
        <option value="">暂未选择</option>
        {repositories.map(({ id, fullName }) => <option key={id} value={id}>{fullName}</option>)}
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
      <button>{task ? '保存任务' : '创建任务'}</button>
    </form>
  );
}

export async function Tasks({ project, selectedId }: { project: Project; selectedId?: string }) {
  const path = `/projects/${project.id}/tasks`;
  const tasks = await read<Task[]>(path) ?? [];
  const selected = tasks.find(({ id }) => selectedId === id);
  const canWrite = project.status === 'active' && project.role !== 'viewer';
  const [task, events, repositories] = await Promise.all([
    selected ? read<TaskDetail>(`${path}/${selected.id}`) : null,
    selected ? read<TaskEvent[]>(`${path}/${selected.id}/events`) : null,
    canWrite ? read<RepositoryBinding[]>(`/projects/${project.id}/repositories`) : null,
  ]);
  const taskLink = (id: string) => `/?project=${project.id}&task=${id}#task-detail`;
  const labels = new Map(tasks.map(({ id, code }) => [id, code]));
  const taskIdentity = task && <>
    <input type="hidden" name="projectId" value={project.id} />
    <input type="hidden" name="taskId" value={task.id} />
  </>;
  return (
    <section className="panel" aria-labelledby="tasks-heading">
      <h2 id="tasks-heading">研发任务</h2>
      <p className="muted">{tasks.filter(({ archivedAt }) => !archivedAt).length} 项未归档 · {tasks.filter(({ status }) => status === 'COMPLETED').length} 项已完成</p>
      <nav aria-label="项目任务">
        {tasks.map((item) => (
          <Link key={item.id} href={taskLink(item.id)} aria-current={task?.id === item.id ? 'page' : undefined}>
            <span>{item.code} · {item.title}</span>
            <small>{item.archivedAt ? '已归档' : statusLabels[item.status]}</small>
          </Link>
        ))}
      </nav>
      {canWrite && <details><summary>创建研发任务</summary>
        <TaskForm projectId={project.id} tasks={tasks} repositories={repositories ?? []} />
      </details>}
      {task && <article id="task-detail" key={task.id}>
        <h3>{task.code} · {task.title}</h3>
        <p className="muted">{task.priority} · {statusLabels[task.status]}{task.archivedAt && ' · 已归档'}</p>
        <p className="description">{task.description}</p>
        {task.acceptanceCriteria.length > 0 && <>
          <h4>验收条件</h4><ul>{task.acceptanceCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
        </>}
        {task.parentTaskId && <p>父任务 <Link href={taskLink(task.parentTaskId)}>{labels.get(task.parentTaskId)}</Link></p>}
        {task.dependencies.length > 0 && <p>前置任务 {task.dependencies.map((id) => (
          <Link key={id} href={taskLink(id)} className="task-link">{labels.get(id)}</Link>
        ))}</p>}
        {canWrite && !task.archivedAt && <>
          {editable.includes(task.status) && <details><summary>编辑任务</summary>
            <TaskForm projectId={project.id} task={task} tasks={tasks} repositories={repositories ?? []} />
          </details>}
          {canManageStates.includes(task.status) && <div className="inline-fields">
            {taskActions.filter(({ status, ownerOnly }) => canTransitionTask(task.status, status)
              && (!ownerOnly || project.role === 'owner')).map(({ status, label }) => (
              <form action={transitionTask} key={status}>
                {taskIdentity}<button name="status" value={status}>{label}</button>
              </form>
            ))}
          </div>}
          {project.role === 'owner' && ['CREATED', 'CANCELLED', 'COMPLETED'].includes(task.status) &&
            <form action={archiveTask} className="repository-form">{taskIdentity}<button className="secondary">归档任务</button></form>}
        </>}
        <Executions project={project} task={task}
          hasChecks={Boolean(repositories?.find(({ id }) => id === task.repositoryId)?.checks.length)} />
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
