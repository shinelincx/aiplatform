import type { Account, Project, ProjectMember, ProjectOverview } from '@ado/shared';
import Link from 'next/link';
import { archiveProject, changeMember, createProject, createUser, updateProject } from './actions';
import { RefreshExecution } from './refresh-execution';

const roleNames = { owner: '所有者', member: '成员', viewer: '只读' };
const alertNames: Record<ProjectOverview['alerts'][number]['kind'], string> = {
  planning: 'Agent 规划失败', worker_failed: 'Worker 执行失败', worker_timeout: 'Worker 执行超时',
  worker_unavailable: '暂无符合条件的在线 Worker',
  qa: 'QA 审查失败', delivery: 'PR 发布失败',
};

export function ProjectSidebar({ projects, selected, admin }: {
  projects: Project[];
  selected?: Project;
  admin: boolean;
}) {
  return (
    <aside>
      <h2>项目</h2>
      {projects.length === 0 && <p>当前账号没有项目。</p>}
      <nav aria-label="切换项目">
        {projects.map((project) => (
          <Link key={project.id} href={`/?project=${project.id}`} aria-current={selected?.id === project.id ? 'page' : undefined}>
            <span>{project.name}</span>
            <small>{project.status === 'archived' ? '已归档' : project.code}</small>
          </Link>
        ))}
      </nav>
      {admin && (
        <details>
          <summary>创建项目</summary>
          <form action={createProject} className="fields">
            <label>项目代码<input name="code" maxLength={50} pattern="[A-Za-z][A-Za-z0-9_\-]*" required /></label>
            <label>项目名称<input name="name" maxLength={200} required /></label>
            <label>说明<textarea name="description" maxLength={4000} /></label>
            <button>创建项目</button>
          </form>
        </details>
      )}
    </aside>
  );
}

export function ProjectDetails({ project, members, users, overview, taskId, live }: {
  project: Project;
  members: ProjectMember[];
  users: Account[];
  overview: ProjectOverview | null;
  taskId?: string;
  live: boolean;
}) {
  const canEdit = project.role === 'owner' && project.status === 'active';
  const assignable = users.filter((user) => user.status === 'active' && !members.some((member) => member.id === user.id));
  return (
    <section className="panel project-overview" aria-labelledby="project-heading">
      <h2 id="project-heading">{project.name}</h2>
      <p className="muted">{project.code} · {project.status === 'active' ? '进行中' : '已归档'} · {roleNames[project.role]}</p>
      {project.description && <p className="description">{project.description}</p>}
      {overview && <>
        {live && project.status === 'active' && <RefreshExecution intervalMs={15000} />}
        <dl className="project-metrics">
          <div><dt>研发任务</dt><dd>{overview.tasks.open} 项进行中 · {overview.tasks.completed} 项已完成</dd></div>
          <div><dt>待审批方案</dt><dd>{overview.tasks.approval} 项</dd></div>
          <div><dt>已启用 Agent</dt><dd>{overview.agentsEnabled} 个</dd></div>
          <div><dt>在线 Worker</dt><dd>{overview.workers.online} / {overview.workers.total}</dd>
            {overview.workers.diskPaused > 0 && <small>{overview.workers.diskPaused} 台因磁盘空间不足暂停领取</small>}
          </div>
        </dl>
        {overview.alerts.length > 0 && <>
          <h3>需要处理</h3>
          <nav aria-label="需要处理的任务">
            {overview.alerts.map((alert) => <Link key={alert.taskId} href={`/?project=${project.id}&task=${alert.taskId}#task-detail`}>
              <span>{alert.code} · {alert.title}</span><small>{alertNames[alert.kind]}</small>
            </Link>)}
          </nav>
        </>}
      </>}
      <details className="project-settings"><summary>项目设置与运行信息</summary>
      {overview && <p className="execution-summary">执行队列 · {overview.executions.queued} 项排队 · {overview.executions.running} 项运行 / 成功执行 · {overview.executions.succeeded} / {overview.executions.total}</p>}
      <p><Link href={`/?project=${project.id}${taskId ? `&task=${encodeURIComponent(taskId)}` : ''}&section=operations#operations`}>项目用量与审计</Link></p>
      {canEdit && (
        <details>
          <summary>编辑项目</summary>
          <form className="fields" action={updateProject}>
            <input type="hidden" name="projectId" value={project.id} />
            <label>项目名称<input name="name" defaultValue={project.name} maxLength={200} required /></label>
            <label>说明<textarea name="description" defaultValue={project.description} maxLength={4000} /></label>
            <button>保存项目</button>
          </form>
        </details>
      )}
      {project.role === 'owner' && (
        <details>
          <summary>项目成员</summary>
          <ul className="members">
            {members.map((member) => (
              <li key={member.id}>
                <span>{member.name} <small>{member.email} · {roleNames[member.role]}</small></span>
                {canEdit && member.role !== 'owner' && (
                  <form action={changeMember} className="inline-fields">
                    <input type="hidden" name="projectId" value={project.id} />
                    <input type="hidden" name="userId" value={member.id} />
                    <select aria-label={`${member.name} 的权限`} name="role" defaultValue={member.role}>
                      <option value="member">成员</option><option value="viewer">只读</option><option value="remove">移除</option>
                    </select>
                    <button>更新</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {canEdit && assignable.length > 0 && (
            <form action={changeMember} className="fields">
              <input type="hidden" name="projectId" value={project.id} />
              <label>账号<select name="userId" required>
                {assignable.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
              </select></label>
              <label>权限<select name="role"><option value="member">成员</option><option value="viewer">只读</option></select></label>
              <button>添加成员</button>
            </form>
          )}
        </details>
      )}
      {canEdit && (
        <details>
          <summary>归档项目</summary>
          <form action={archiveProject} className="fields">
            <input type="hidden" name="projectId" value={project.id} />
            <p>归档后仍可查看项目，项目设置将锁定。</p>
            <button>确认归档</button>
          </form>
        </details>
      )}
      </details>
    </section>
  );
}

export function CreateAccount({ users }: { users: Account[] }) {
  return (
    <details className="panel">
      <summary>账号管理</summary>
      <ul className="members">
        {users.map((user) => (
          <li key={user.id}><span>{user.name} <small>{user.email}</small></span>
            <small>{user.systemRole === 'admin' ? '管理员' : '普通用户'}</small></li>
        ))}
      </ul>
      <form action={createUser} className="fields">
        <label>姓名<input name="name" maxLength={100} required /></label>
        <label>邮箱<input name="email" type="email" maxLength={255} required /></label>
        <label>初始密码<input name="password" type="password" minLength={12} maxLength={256} autoComplete="new-password" required /></label>
        <button>创建账号</button>
      </form>
    </details>
  );
}
