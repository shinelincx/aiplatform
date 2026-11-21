import Link from 'next/link';
import { isWorkerId, knowledgeKinds, type KnowledgeEntry, type KnowledgeKind, type KnowledgeVersion,
  type Project, type RepositoryBinding } from '@ado/shared';
import { saveKnowledgeVersion, updateKnowledgeVersion } from './actions';
import { readSection } from './api-client';
import { SectionReadError } from './section-feedback';
import { ActionFeedback, SubmitButton } from './task-feedback';

const labels: Record<KnowledgeKind, string> = { project_document: '项目文档', design_rule: '设计规则' };
const notices: Record<string, string> = {
  saved: '知识版本已登记，等待审批。',
  approved: '知识版本已批准，可以启用。',
  rejected: '知识版本已驳回。',
  activate: '知识版本已启用。',
  retire: '知识版本已从新规划中撤下。',
};
const errors: Record<string, string> = {
  expired: '会话已失效，请重新登录。',
  forbidden: '当前账号没有修改项目知识的权限。',
  conflict: '知识版本状态已变化，请核对当前版本。',
  offline: '无法确认操作结果，请刷新后核对。',
  invalid: '无法保存项目知识，请核对来源、版本和验收证据。',
};

type EntryDetail = Omit<KnowledgeEntry, 'version' | 'matchedVersionId'> & { versions: KnowledgeVersion[] };

function VersionForm({ project, taskId, kind, entryId, repositories }: {
  project: Project; taskId?: string; kind: KnowledgeKind; entryId?: string; repositories: RepositoryBinding[];
}) {
  return <details>
    <summary>{entryId ? '登记新版本' : `登记${labels[kind]}`}</summary>
    <form action={saveKnowledgeVersion} className="fields">
      <input type="hidden" name="projectId" value={project.id} />
      {taskId && <input type="hidden" name="taskId" value={taskId} />}
      <input type="hidden" name="knowledgeKind" value={kind} />
      {entryId ? <input type="hidden" name="entryId" value={entryId} />
        : <label>标题<input name="title" required maxLength={200} /></label>}
      <label>来源链接<input name="sourceUrl" type="url" required maxLength={2000} /></label>
      <label>来源版本或提交<input name="sourceRevision" required maxLength={120} /></label>
      <label>内容摘录<textarea name="excerpt" required maxLength={4000} /></label>
      <label>版本变更说明（可选）<textarea name="versionNote" maxLength={1000} /></label>
      {kind === 'design_rule' && <>
        <label>实现仓库<select name="evidenceRepositoryId" defaultValue="" required>
          <option value="" disabled>选择项目仓库</option>
          {repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.fullName}</option>)}
        </select></label>
        <label>实现提交 SHA<input name="implementationCommit" pattern="[0-9a-f]{40}" maxLength={40} required /></label>
        <label>验收报告链接<input name="reportUrl" type="url" maxLength={2000} required /></label>
        <label>已批准归档的执行 ID（可选）<input name="evidenceRunId" maxLength={36} /></label>
      </>}
      <SubmitButton pendingLabel="正在登记…">保存版本草稿</SubmitButton>
    </form>
  </details>;
}

export async function KnowledgePanel({ project, taskId, search, kind, history, entryId, versionId, result }: {
  project: Project; taskId?: string; search?: string; kind?: string; history?: string;
  entryId?: string; versionId?: string; result?: string;
}) {
  const root = `/projects/${project.id}/knowledge`;
  const owner = project.role === 'owner' && project.status === 'active';
  const options = new URLSearchParams();
  const filter = knowledgeKinds.find(candidate => candidate === kind);
  const term = typeof search === 'string' ? search.slice(0, 160) : '';
  if (term) options.set('q', term);
  if (filter) options.set('kind', filter);
  if (history === '1') options.set('history', '1');
  const [list, detail, repositories] = await Promise.all([
    readSection<KnowledgeEntry[]>(`${root}?${options}`, Array.isArray),
    isWorkerId(entryId) ? readSection<EntryDetail>(`${root}/${entryId}`, data => Array.isArray(data.versions)) : null,
    owner ? readSection<RepositoryBinding[]>(`/projects/${project.id}/repositories`, Array.isArray) : null,
  ]);
  const entry = detail?.data;
  const active = entry?.versions.find(item => item.id === entry.activeVersionId);
  const version = versionId ? entry?.versions.find(item => item.id === versionId) : active ?? entry?.versions[0];
  const notice = result && Object.hasOwn(notices, result) ? notices[result] : undefined;
  const error = result && Object.hasOwn(errors, result) ? errors[result] : undefined;
  const message = notice ?? error;
  const identity = <>
    <input type="hidden" name="projectId" value={project.id} />
    {taskId && <input type="hidden" name="taskId" value={taskId} />}
  </>;
  const selection = new URLSearchParams({ project: project.id, section: 'knowledge' });
  if (taskId) selection.set('task', taskId);
  if (term) selection.set('knowledgeQuery', term);
  if (filter) selection.set('knowledgeKind', filter);
  if (history === '1') selection.set('knowledgeHistory', '1');
  const link = (id: string, selectedVersion?: string) => {
    const query = new URLSearchParams(selection);
    query.set('knowledgeEntry', id);
    if (selectedVersion) query.set('knowledgeVersion', selectedVersion);
    return `/?${query}#project-knowledge`;
  };

  return <>
    {message && <ActionFeedback key={result} message={message} error={Boolean(error)} />}
    <form method="get" action="/#project-knowledge" className="fields">
      {identity}
      <input type="hidden" name="section" value="knowledge" />
      <label>搜索项目知识<input name="knowledgeQuery" type="search" defaultValue={term} maxLength={160} /></label>
      <label>类别<select name="knowledgeKind" defaultValue={filter ?? ''}>
        <option value="">全部</option>
        {knowledgeKinds.map(item => <option key={item} value={item}>{labels[item]}</option>)}
      </select></label>
      <label className="checkbox"><input type="checkbox" name="knowledgeHistory" value="1" defaultChecked={history === '1'} />显示历史版本</label>
      <button className="secondary">搜索知识</button>
    </form>
    {list.issue ? <SectionReadError label="项目知识" issue={list.issue} />
      : list.data.length === 0 ? <p className="muted">没有匹配的项目知识。</p>
      : <ul className="members">{list.data.map(item => <li key={item.id}>
        <Link href={link(item.id, item.matchedVersionId)} aria-current={item.id === entry?.id ? 'page' : undefined}>{item.title}</Link>
        <small>{labels[item.kind]} · {history === '1' ? `匹配 v${item.version}` : `现用 v${item.version}`}</small>
      </li>)}</ul>}
    {detail?.issue && <SectionReadError label="知识版本" issue={detail.issue} />}
    {entry && !version && <p role="alert" className="feedback">所选版本不存在或不可访问。 <Link href={link(entry.id)}>查看可用版本</Link></p>}
    {entry && version && <section aria-labelledby="knowledge-entry-heading">
      <h3 id="knowledge-entry-heading">{entry.title}</h3>
      <nav aria-label="知识版本"><ul className="members">{entry.versions.map(item => <li key={item.id}>
        <Link href={link(entry.id, item.id)} aria-current={item.id === version.id ? 'page' : undefined}>
          v{item.version} · {item.id === entry.activeVersionId ? '现用' : item.decision === 'approved' ? '已批准'
            : item.decision === 'rejected' ? '已驳回' : '待批准'}
        </Link>
      </li>)}</ul></nav>
      <h4>版本 v{version.version}</h4>
      {version.id !== entry.activeVersionId && version.decision === 'approved' && <p className="muted">
        {active ? `当前使用 v${active.version}。` : '此条目已从新规划撤下。'}
      </p>}
      <p><a href={version.sourceUrl} rel="noreferrer">查看来源</a> · {version.sourceRevision}</p>
      <p className="description">{version.excerpt}</p>
      {version.versionNote && <p>{version.versionNote}</p>}
      <p><small>摘录 SHA-256 · <code>{version.excerptHash}</code></small></p>
      {version.decidedBy && version.decidedAt && <small>
        审核人 · {version.decidedBy} · <time dateTime={version.decidedAt}>{new Date(version.decidedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Singapore' })}</time>
      </small>}
      {version.designEvidence && <ul>
        <li><a href={`${version.designEvidence.repositoryUrl.replace(/\/$/, '')}/commit/${version.designEvidence.implementationCommit}`} rel="noreferrer">
          查看实现提交 {version.designEvidence.implementationCommit.slice(0, 12)}
        </a></li>
        <li><a href={version.designEvidence.reportUrl} rel="noreferrer">查看验收报告</a></li>
        {version.designEvidence.archive && <li>
          <a href={`/artifacts/${project.id}/${version.designEvidence.archive.taskId}/${version.designEvidence.archive.runId}`}>
            下载批准归档 {version.designEvidence.archive.patchHash.slice(0, 12)}
          </a>
        </li>}
      </ul>}
      {owner && version.decision !== 'rejected' && <form action={updateKnowledgeVersion} className="inline-fields">
        {identity}
        <input type="hidden" name="entryId" value={entry.id} />
        <input type="hidden" name="versionId" value={version.id} />
        {version.decision === null ? <>
          <SubmitButton name="operation" value="approved" pendingLabel="正在审核…">批准知识版本</SubmitButton>
          <SubmitButton name="operation" value="rejected" className="secondary" pendingLabel="正在审核…">驳回知识版本</SubmitButton>
        </> : version.id === entry.activeVersionId
          ? <SubmitButton name="operation" value="retire" className="secondary" pendingLabel="正在撤下…">撤下版本</SubmitButton>
          : <SubmitButton name="operation" value="activate" pendingLabel="正在启用…">启用版本</SubmitButton>}
      </form>}
      {owner && (entry.kind !== 'design_rule' || Boolean(repositories?.data?.length)) && <VersionForm
        project={project} taskId={taskId} entryId={entry.id} kind={entry.kind} repositories={repositories?.data ?? []} />}
    </section>}
    {owner && <VersionForm project={project} taskId={taskId} kind="project_document" repositories={[]} />}
    {owner && (repositories?.issue ? <SectionReadError label="设计规则的实现仓库" issue={repositories.issue} />
      : repositories?.data?.length ? <VersionForm project={project} taskId={taskId} kind="design_rule" repositories={repositories.data} />
      : <p className="muted">绑定项目仓库后可登记设计规则及验收证据。</p>)}
  </>;
}
