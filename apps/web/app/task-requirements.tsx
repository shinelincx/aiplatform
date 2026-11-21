import { maxPlanKnowledgeVersions, type KnowledgeEntry, type Project, type ProjectRequirement, type RepositoryBinding } from '@ado/shared';
import { registerRequirement, retireRequirement, startAgentPlan } from './actions';
import { api, readSection } from './api-client';
import { SectionReadError } from './section-feedback';
import { ActionFeedback, SubmitButton } from './task-feedback';

const unavailable = '暂时无法读取需求来源，请稍后重试。';
const signIn = '读取需求来源需要有效会话，请重新登录后重试。';
const forbidden = '当前账号无法读取需求来源，请联系项目所有者确认权限。';

async function readRequirements(projectId: string): Promise<
  { sources: ProjectRequirement[]; error?: never } | { sources?: never; error: string }
> {
  try {
    const response = await api(`/projects/${projectId}/requirements`);
    if (response.status === 401) return { error: signIn };
    if (response.status === 403) return { error: forbidden };
    if (response.ok) {
      const sources: unknown = await response.json();
      if (Array.isArray(sources)) return { sources };
    }
  } catch {
    return { error: unavailable };
  }
  return { error: unavailable };
}

const notices: Record<string, string> = {
  registered: '已登记批准的需求来源。',
  retired: '已从新任务的可选需求来源中撤下。',
};

const issues: Record<string, string> = {
  expired: '需求来源操作未完成，请重新登录后重试。',
  forbidden: '当前账号没有操作需求来源的权限，请联系项目所有者。',
  offline: '无法确认需求来源操作结果，请重新加载列表核对。',
  conflict: '需求来源状态已变化，请核对列表后重试。',
  requirement: '无法更新需求来源，请核对来源状态、HTTPS 链接、标题和摘录。',
};

export async function TaskRequirements({ project, taskId, result, repositories, canWrite }: {
  project: Project;
  taskId?: string;
  result?: string;
  repositories: RepositoryBinding[];
  canWrite: boolean;
}) {
  const [{ sources, error }, knowledge] = await Promise.all([
    readRequirements(project.id),
    canWrite && repositories.length ? readSection<KnowledgeEntry[]>(`/projects/${project.id}/knowledge`, Array.isArray) : null,
  ]);
  const manageRequirements = project.role === 'owner' && project.status === 'active';
  const retryUrl = `/?project=${project.id}${taskId ? `&task=${taskId}` : ''}&requirementResult=refresh#task-requirements`;
  const notice = result && Object.hasOwn(notices, result) ? notices[result] : undefined;
  const feedback = notice ?? (result && Object.hasOwn(issues, result) ? issues[result] : undefined);

  return <>
    <details id="task-requirements" open={Boolean(result || error)}>
      <summary>已批准的需求来源</summary>
      {feedback && <ActionFeedback key={result} message={feedback} error={!notice} />}
      {error ? <p className="feedback" role="alert">{error} <a href={retryUrl}>重新加载需求来源</a></p> : sources?.length ? <ul className="members">{sources.map((source) => <li key={source.id}>
        <div>
          <a href={source.referenceUrl} rel="noreferrer">{source.title}</a>
          <p className="description">{source.excerpt}</p>
          <small>登记人 · {source.approvedBy}</small>
        </div>
        {manageRequirements && <form action={retireRequirement}>
          <input type="hidden" name="projectId" value={project.id} />
          {taskId && <input type="hidden" name="taskId" value={taskId} />}
          <input type="hidden" name="requirementId" value={source.id} />
          <SubmitButton className="secondary" pendingLabel="正在撤下…">从新任务撤下</SubmitButton>
        </form>}
      </li>)}</ul> : <p className="muted">尚未登记需求来源。</p>}
      {manageRequirements && <form action={registerRequirement} className="fields">
        <input type="hidden" name="projectId" value={project.id} />
        {taskId && <input type="hidden" name="taskId" value={taskId} />}
        <label>需求标题<input name="title" maxLength={200} required /></label>
        <label>已批准的 Issue 或 PRD 链接<input name="referenceUrl" type="url" maxLength={2000} required /></label>
        <label>批准内容摘录<textarea name="excerpt" maxLength={4000} required /></label>
        <SubmitButton pendingLabel="正在登记…">登记已批准需求</SubmitButton>
      </form>}
    </details>
    {canWrite && repositories.length > 0 && <details><summary>用 Agent 规划需求</summary>
      <form className="fields" action={startAgentPlan}>
        <input type="hidden" name="projectId" value={project.id} />
        <label>目标仓库<select name="repositoryId" required>
          {repositories.map(({ id, fullName }) => <option key={id} value={id}>{fullName}</option>)}
        </select></label>
        {Boolean(sources?.length) && <label>采用已批准需求<select name="requirementId">
          <option value="">未选择</option>
          {sources?.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
        </select></label>}
        {knowledge?.issue && <SectionReadError label="可用于规划的项目知识" issue={knowledge.issue} />}
        {knowledge?.data?.some(item => item.activeVersionId) && <details>
          <summary>选择项目知识（可选）</summary>
          <fieldset>
            <legend>最多选择 {maxPlanKnowledgeVersions} 个已启用的版本</legend>
            {knowledge.data.filter(item => item.activeVersionId).map(item => <label key={item.id} className="checkbox">
              <input type="checkbox" name="knowledgeVersionIds" value={item.activeVersionId ?? ''} />
              {item.title} · v{item.version}
            </label>)}
          </fieldset>
        </details>}
        <label>需求<textarea name="request" maxLength={8000} required /></label>
        <SubmitButton pendingLabel="正在提交…">开始规划</SubmitButton>
      </form>
    </details>}
  </>;
}
