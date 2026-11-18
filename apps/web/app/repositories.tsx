import type { GitHubInstallation, GitHubRepository, Project, RepositoryBinding } from '@ado/shared';
import { bindRepository, updateRepositoryChecks } from './actions';
import { read } from './api-client';

export async function Repositories({ project, manage, installation }: {
  project: Project;
  manage: boolean;
  installation?: string;
}) {
  const path = `/projects/${project.id}/repositories`;
  const [bindings, result] = await Promise.all([
    read<RepositoryBinding[]>(path),
    manage ? read<{ configured: boolean; installations: GitHubInstallation[] }>(`${path}/installations`)
      .catch(() => null) : null,
  ]);
  const chosen = result?.installations.find(({ id }) => String(id) === installation) ?? result?.installations[0];
  const candidates = chosen ? await read<GitHubRepository[]>(`${path}/installations/${chosen.id}`).catch(() => null) : null;
  const canConfigure = project.role === 'owner' && project.status === 'active';

  return (
    <section className="panel" aria-labelledby="repository-heading">
      <h2 id="repository-heading">GitHub 仓库</h2>
      {bindings?.length ? <ul className="members">
        {bindings.map(({ id, url, fullName, defaultBranch, checks, autoDraftPr }) => (
          <li key={id}>
            <div>
              <a href={url}>{fullName}</a>
              <p><small>默认分支 · {defaultBranch} · {checks.length} 项检查</small></p>
              {canConfigure && <details>
                <summary>检查与交付设置</summary>
                <form action={updateRepositoryChecks} className="fields">
                  <input type="hidden" name="projectId" value={project.id} />
                  <input type="hidden" name="repositoryId" value={id} />
                  <label>检查计划 JSON<textarea name="checks" rows={8} cols={53} maxLength={24000}
                    defaultValue={JSON.stringify(checks, null, 2)} required /></label>
                  <p className="muted">每项包含 name、kind 和 argv。kind 支持 unit、api 和 static。可填写相对目录 directory 和超时秒数 timeoutSeconds。</p>
                  <label className="checkbox">
                    <input type="checkbox" name="autoDraftPr" defaultChecked={autoDraftPr} />
                    人工审核通过后自动发布分支并创建草稿 PR
                  </label>
                  <button>保存检查与交付设置</button>
                </form>
              </details>}
            </div>
          </li>
        ))}
      </ul> : <p className="muted">尚未绑定仓库。</p>}
      {manage && !result && <p role="status">无法读取 GitHub App 授权，请检查配置。</p>}
      {manage && result && !result.configured && <p className="muted">配置并安装 GitHub App 后可选择仓库。</p>}
      {result?.configured && result.installations.length === 0 && <p className="muted">GitHub App 暂无有效安装。</p>}
      {chosen && <>
        <form action="/" className="inline-fields">
          <input type="hidden" name="project" value={project.id} />
          <select name="installation" aria-label="GitHub App 安装账号" defaultValue={chosen.id}>
            {result?.installations.map(({ id, account }) => <option key={id} value={id}>{account}</option>)}
          </select>
          <button className="secondary">查看仓库</button>
        </form>
        {candidates?.length ? (
          <form className="fields repository-form" action={bindRepository} key={chosen.id}>
            <input type="hidden" name="projectId" value={project.id} />
            <input type="hidden" name="installationId" value={chosen.id} />
            <label>仓库<select name="repositoryId" required>
              {candidates.map(({ id, fullName, defaultBranch }) => <option key={id} value={id}>{fullName} · {defaultBranch}</option>)}
            </select></label>
            <label>任务默认分支<input name="defaultBranch" maxLength={255} placeholder="留空使用 GitHub 默认分支" /></label>
            <button>保存绑定</button>
          </form>
        ) : <p role="status">{candidates ? '此安装没有可用仓库。' : '无法查询已授权仓库。'}</p>}
      </>}
    </section>
  );
}
