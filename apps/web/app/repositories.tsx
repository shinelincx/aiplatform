import type { GitHubInstallation, GitHubRepository, Project, RepositoryBinding } from '@ado/shared';
import { bindRepository, updateRepositoryChecks } from './actions';
import { readSection, type ReadIssue } from './api-client';
import { SectionReadError } from './section-feedback';
import { ActionDialog } from './console-controls';
import { Icon } from './icons';
import { workspaceHref } from './workspace';

export async function Repositories({ project, bindings, bindingIssue, manage, installation }: {
  project: Project;
  bindings: RepositoryBinding[];
  bindingIssue?: ReadIssue;
  manage: boolean;
  installation?: string;
}) {
  const path = `/projects/${project.id}/repositories`;
  const installationsResult = manage ? await readSection<{ configured: boolean; installations: GitHubInstallation[] }>(`${path}/installations`,
    (data) => typeof data.configured === 'boolean' && Array.isArray(data.installations)) : null;
  const result = installationsResult?.data;
  const chosen = result?.installations.find(({ id }) => String(id) === installation) ?? result?.installations[0];
  const candidatesResult = chosen
    ? await readSection<GitHubRepository[]>(`${path}/installations/${chosen.id}`, Array.isArray) : null;
  const candidates = candidatesResult?.data;
  const canConfigure = project.role === 'owner' && project.status === 'active';

  return (
    <section aria-labelledby="repository-heading">
      <header className="page__head">
        <div>
          <p className="eyebrow">{project.code} / REPOSITORIES</p>
          <h1 id="repository-heading">代码仓库</h1>
        </div>
        <div className="page-actions">
          <div className="headstat"><small>CONNECTED</small><strong>{bindings.length}</strong></div>
          {manage && <ActionDialog title="绑定仓库" actionKey="repo-bind" openOnLoad={Boolean(installation)}
            closeHref={workspaceHref(project.id, 'repositories')}>
            {installationsResult?.issue ? <SectionReadError label="GitHub App 授权" issue={installationsResult.issue} />
              : !result ? <p className="empty">无法读取 GitHub App 授权</p>
              : !result.configured ? <p className="empty">GitHub App 未配置</p>
              : !chosen ? <p className="empty">暂无有效安装</p>
              : <>
                {result.installations.length > 1 && <form action="/" className="inline-fields">
                  <input type="hidden" name="project" value={project.id} />
                  <input type="hidden" name="section" value="repositories" />
                  <label>GitHub App 安装<select name="installation" defaultValue={chosen.id}>
                    {result.installations.map(({ id, account }) => <option key={id} value={id}>{account}</option>)}
                  </select></label>
                  <button className="secondary">切换安装</button>
                </form>}
                {candidatesResult?.issue ? <SectionReadError label="可绑定仓库" issue={candidatesResult.issue} /> : candidates?.length ? <form className="fields modal-group" action={bindRepository} key={chosen.id}>
                  <input type="hidden" name="projectId" value={project.id} />
                  <input type="hidden" name="installationId" value={chosen.id} />
                  <label>仓库<select name="repositoryId" required>
                    {candidates.map(({ id, fullName, defaultBranch }) => <option key={id} value={id}>{fullName} · {defaultBranch}</option>)}
                  </select></label>
                  <label>任务默认分支<input name="defaultBranch" maxLength={255} placeholder="使用 GitHub 默认分支" /></label>
                  <div className="form-actions"><button>保存绑定</button></div>
                </form> : <p className="empty">{candidates ? '此安装没有可用仓库' : '无法查询已授权仓库'}</p>}
              </>}
          </ActionDialog>}
        </div>
      </header>
      {bindingIssue ? <SectionReadError label="已绑定仓库" issue={bindingIssue} /> : bindings.length ? <ul className="resource-grid">
        {bindings.map(({ id, url, fullName, defaultBranch, checks, independentChecks, autoDraftPr, installationId }) => (
          <li className="panel resource" key={id}>
              <header className="resource__head">
                <span className="resource__icon"><Icon name="git" /></span>
                <div><h2>{fullName}</h2><small>GITHUB · {project.code}</small></div>
                <a className="linkbtn" href={url}>GitHub <Icon name="arrow" /></a>
              </header>
              <dl className="resource__metrics">
                <div><dt>DEFAULT BRANCH</dt><dd>{defaultBranch}</dd></div>
                <div><dt>CHECKS</dt><dd>{checks.length}</dd></div>
                <div><dt>INSTALLATION</dt><dd>#{installationId}</dd></div>
                <div><dt>DRAFT PR</dt><dd>{autoDraftPr ? '自动' : '手动'}</dd></div>
              </dl>
              {canConfigure && <ActionDialog title={`检查与交付 · ${fullName}`} actionKey={`checks:${id}`} trigger="检查与交付设置">
                <form action={updateRepositoryChecks} className="fields">
                  <input type="hidden" name="projectId" value={project.id} />
                  <input type="hidden" name="repositoryId" value={id} />
                  <label>检查计划 JSON<textarea name="checks" rows={8} cols={53} maxLength={24000}
                    defaultValue={JSON.stringify(checks, null, 2)} required /></label>
                  <p className="muted">每项包含 name、kind 和 argv。kind 支持 unit、api 和 static。可填写相对目录 directory 和超时秒数 timeoutSeconds。</p>
                  <label>必需独立复验 JSON<textarea name="independentChecks" rows={4} cols={53} maxLength={5000}
                    defaultValue={JSON.stringify(independentChecks, null, 2)} required /></label>
                  <p className="muted">每项填写 name 和 kind。kind 支持 static、unit、integration、browser、security 和 dependency。新派发沿用保存时的清单。</p>
                  <label className="checkbox">
                    <input type="checkbox" name="autoDraftPr" defaultChecked={autoDraftPr} />
                    人工审核通过后自动发布分支并创建草稿 PR
                  </label>
                  <div className="form-actions"><button>保存检查与交付设置</button></div>
                </form>
              </ActionDialog>}
          </li>
        ))}
      </ul> : <div className="panel"><p className="empty">尚未绑定仓库。</p></div>}
    </section>
  );
}
