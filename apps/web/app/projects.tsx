import type { Account, Project, ProjectMember } from '@ado/shared';
import Link from 'next/link';
import { archiveProject, changeMember, createProject, createUser, updateProject } from './actions';

const roleNames = { owner: '所有者', member: '成员', viewer: '只读' };

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

export function ProjectDetails({ project, members, users }: {
  project: Project;
  members: ProjectMember[];
  users: Account[];
}) {
  const canEdit = project.role === 'owner' && project.status === 'active';
  const assignable = users.filter((user) => user.status === 'active' && !members.some((member) => member.id === user.id));
  return (
    <section className="panel" aria-labelledby="project-heading">
      <h2 id="project-heading">{project.name}</h2>
      <p className="muted">{project.code} · {project.status === 'active' ? '进行中' : '已归档'} · {roleNames[project.role]}</p>
      {project.description && <p className="description">{project.description}</p>}
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
