import type { Account, Project, ProjectMember, ProjectOverview } from '@ado/shared';
import Link from 'next/link';
import { archiveProject, changeMember, updateProject } from './actions';
import { ActionDialog } from './console-controls';
import { Icon } from './icons';
import { RefreshExecution } from './refresh-execution';

const roleNames = { owner: '所有者', member: '成员', viewer: '只读' };
const alertNames: Record<ProjectOverview['alerts'][number]['kind'], string> = {
  planning: 'Agent 规划失败', worker_failed: 'Worker 执行失败', worker_timeout: 'Worker 执行超时',
  worker_unavailable: '暂无符合条件的在线 Worker',
  qa: 'QA 审查失败', delivery: 'PR 发布失败',
};

export function ProjectDetails({ project, members, users, overview, live, reachable }: {
  project: Project;
  members: ProjectMember[];
  users: Account[];
  overview: ProjectOverview | null;
  live: boolean;
  reachable: boolean;
}) {
  const canEdit = project.role === 'owner' && project.status === 'active';
  const assignable = users.filter((user) => user.status === 'active' && !members.some((member) => member.id === user.id));
  return (
    <section className="project-overview" aria-label="项目设置与告警">
      {live && project.status === 'active' && <RefreshExecution intervalMs={15000} />}

      {overview && overview.alerts.length > 0 && (
        <div className="alert-board">
          <div className="alert-board__head">
            <span className="eyebrow">Needs attention / 需要处理</span>
            <em>{overview.alerts.length}</em>
          </div>
          <nav aria-label="需要处理的任务" className="alert-list">
            {overview.alerts.map((alert) => (
              <Link key={alert.taskId} href={`/?project=${project.id}&task=${alert.taskId}#task-detail`}>
                <span><strong>{alert.title}</strong><small>{alert.code}</small></span>
                <span className="alert-tag">{alertNames[alert.kind]}</span>
              </Link>
            ))}
          </nav>
        </div>
      )}

      <section className="panel project-module">
        <header className="panel__head">
          <h2 className="panel__title"><Icon name="grid" />{project.name}</h2>
          <span className="module-tag" data-tone={project.status === 'active' && reachable ? 'mint' : 'mute'}>
            {roleNames[project.role]} · {project.status === 'archived' ? '已归档' : reachable ? '在线' : '离线'}
          </span>
        </header>
        <div className="page-actions">
          <ActionDialog title="项目信息">
            <dl className="modal-facts">
              <div><dt>项目</dt><dd>{project.name}</dd></div>
              <div><dt>代码</dt><dd>{project.code}</dd></div>
              {overview && <>
                <div><dt>排队 / 执行中</dt><dd>{overview.executions.queued} / {overview.executions.running}</dd></div>
                <div><dt>成功 / 总执行</dt><dd>{overview.executions.succeeded} / {overview.executions.total}</dd></div>
              </>}
            </dl>
            {project.description && <p className="description">{project.description}</p>}
            <Link className="linkbtn" href={`/?project=${project.id}&section=operations#operations`}>用量与审计 <Icon name="arrow" /></Link>
          </ActionDialog>
          {canEdit && <ActionDialog title="编辑项目" actionKey="project-edit">
            <form className="fields" action={updateProject}>
              <input type="hidden" name="projectId" value={project.id} />
              <label>项目名称<input name="name" defaultValue={project.name} maxLength={200} required /></label>
              <label>说明<textarea name="description" defaultValue={project.description} maxLength={4000} /></label>
              <div className="form-actions"><button>保存项目</button></div>
            </form>
          </ActionDialog>}
          {project.role === 'owner' && <ActionDialog title="项目成员" actionKey="project-members">
            <ul className="member-list">
              {members.map((member) => (
                <li key={member.id}>
                  <span className="member-name"><strong>{member.name}</strong><small>{member.email} · {roleNames[member.role]}</small></span>
                  {canEdit && member.role !== 'owner' && (
                    <form action={changeMember} className="inline-fields">
                      <input type="hidden" name="projectId" value={project.id} />
                      <input type="hidden" name="userId" value={member.id} />
                      <select aria-label={`${member.name} 的权限`} name="role" defaultValue={member.role} key={member.role}>
                        <option value="member">成员</option><option value="viewer">只读</option><option value="remove">移除</option>
                      </select>
                      <button>更新</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            {canEdit && assignable.length > 0 && <form action={changeMember} className="fields modal-group">
              <input type="hidden" name="projectId" value={project.id} />
              <div className="field-row">
                <label>账号<select name="userId" required>
                  {assignable.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
                </select></label>
                <label>权限<select name="role"><option value="member">成员</option><option value="viewer">只读</option></select></label>
              </div>
              <div className="form-actions"><button>添加成员</button></div>
            </form>}
          </ActionDialog>}
          {canEdit && <ActionDialog title="归档项目" actionKey="project-archive">
            <form action={archiveProject} className="fields">
              <input type="hidden" name="projectId" value={project.id} />
              <p>归档后锁定项目设置，项目仍可查看。</p>
              <div className="form-actions"><button className="btn-danger">确认归档</button></div>
            </form>
          </ActionDialog>}
        </div>
      </section>
    </section>
  );
}
