import type { Project } from '@ado/shared';
import Link from 'next/link';
import { createProject } from '../../actions';
import { read } from '../../api-client';
import { ActionDialog } from '../../console-controls';
import { Icon } from '../../icons';
import { workspaceHref } from '../../workspace';
import { requireSettingsAdmin } from '../session';
import { SettingsScreen, type SettingsSearch } from '../screen';

export const metadata = { title: '项目目录 · ADO' };

export default async function Page({ searchParams }: { searchParams: SettingsSearch }) {
  await requireSettingsAdmin();
  const projects = await read<Project[]>('/projects') ?? [];
  return <SettingsScreen title="项目目录" searchParams={searchParams}>
    <section className="panel">
      <header className="panel__head">
        <h2 className="panel__title"><Icon name="layers" />项目列表 <em>{projects.length}</em></h2>
        <ActionDialog title="创建项目" actionKey="project-create">
          <form action={createProject} className="fields">
            <label>项目代码<input name="code" maxLength={50} pattern="[A-Za-z][A-Za-z0-9_\-]*" required /></label>
            <label>项目名称<input name="name" maxLength={200} required /></label>
            <label>说明<textarea name="description" maxLength={4000} /></label>
            <div className="form-actions"><button>创建项目</button></div>
          </form>
        </ActionDialog>
      </header>
      {projects.length ? <ul className="system-list">{projects.map((project) => (
        <li key={project.id}><Link href={workspaceHref(project.id)} className="system-row">
          <span className="member-name"><strong>{project.name}</strong><small>{project.code}</small></span>
          <span className="module-tag" data-tone={project.status === 'active' ? 'mint' : 'mute'}>
            {project.status === 'active' ? '启用' : '已归档'}
          </span><Icon name="chevron" />
        </Link></li>
      ))}</ul> : <p className="empty">暂无项目</p>}
    </section>
  </SettingsScreen>;
}
