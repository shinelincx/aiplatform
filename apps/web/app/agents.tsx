import { agentRoleLabels, isPlanningFailureCategory, isUsableSkillVersion, planningFailureMessages, type AgentPlan, type AgentRegistry, type Project, type SkillVersion, type SkillVersionStatus } from '@ado/shared';
import { retryAgentPlan, reviewSkillVersion, updateAgent, updateSkill } from './actions';
import { readSection } from './api-client';
import { SectionReadError } from './section-feedback';
import { ActionFeedback, SubmitButton } from './task-feedback';
import { ActionDialog } from './console-controls';
import { Icon } from './icons';
import { StatusDistribution } from './metrics';
import { RefreshExecution } from './refresh-execution';

const skillStatuses: Record<SkillVersionStatus, string> = {
  pending_evaluation: '待评估', evaluation_failed: '评估未通过', awaiting_approval: '待批准',
  approved: '已批准', rejected: '已驳回', legacy: '存量沿用',
};

const skillFeedback: Record<string, string> = {
  enabled: 'Skill 已启用。',
  disabled: 'Skill 已停用。',
  'version-created': 'Skill 版本已创建，可登记评估。',
  evaluated: '版本评估已登记。',
  approved: '版本已批准，可在 Agent 配置中选用。',
  rejected: '版本已驳回。',
  'review-conflict': '版本状态已变化，或尚未满足当前操作的条件。请核对最新状态。',
  'review-failed': '未能保存。请检查输入或稍后重试。',
};

function SkillFeedback({ result }: { result?: string }) {
  if (!result || !Object.hasOwn(skillFeedback, result)) return null;
  return <ActionFeedback message={skillFeedback[result]} error={result.startsWith('review-')} />;
}

function SkillVersionEntry({ version, id, projectId, manage, result }: {
  version: SkillVersion; id: string; projectId: string; manage: boolean; result?: string;
}) {
  const versionInput = <>
    <input type="hidden" name="projectId" value={projectId} />
    <input type="hidden" name="skillId" value={id} />
    <input type="hidden" name="version" value={version.version} />
  </>;
  const { evaluation, decision } = version;
  return <li id={`skill-${id}-v${version.version}`}>
    <h4>v{version.version} · {skillStatuses[version.status]}</h4>
    <SkillFeedback result={result} />
    <p className="description">{version.instructions}</p>
    {evaluation && <>
      <p className="description">评估{evaluation.result === 'passed' ? '通过' : '未通过'} · {evaluation.recordedBy} · <RegistryTime at={evaluation.recordedAt} /></p>
      <p className="description">{evaluation.evidence}</p>
    </>}
    {decision && <p className="description">{decision.decision === 'approved' ? '批准' : '驳回'} · {decision.decidedBy} · <RegistryTime at={decision.decidedAt} /></p>}
    {manage && version.status === 'pending_evaluation' && <form className="fields" action={reviewSkillVersion}>
      {versionInput}<input type="hidden" name="step" value="evaluation" />
      <label>评估结果<select name="result" defaultValue="" required>
        <option value="" disabled>请选择</option><option value="passed">通过</option><option value="failed">未通过</option>
      </select></label>
      <label>评估依据<textarea name="evidence" maxLength={2000} required /></label>
      <SubmitButton pendingLabel="正在登记…">登记评估</SubmitButton>
    </form>}
    {manage && (version.status === 'awaiting_approval' || version.status === 'evaluation_failed') && <form className="inline-fields" action={reviewSkillVersion}>
      {versionInput}<input type="hidden" name="step" value="decision" />
      {version.status === 'awaiting_approval' && <SubmitButton name="decision" value="approved" pendingLabel="正在保存…">批准版本</SubmitButton>}
      <SubmitButton className="secondary" name="decision" value="rejected" pendingLabel="正在保存…">驳回版本</SubmitButton>
    </form>}
  </li>;
}

function RegistryTime({ at }: { at: string }) {
  return <time dateTime={at}>{new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</time>;
}

export async function Agents({ project, selectedSkill, selectedVersion, skillResult }: {
  project: Project; selectedSkill?: string; selectedVersion?: string; skillResult?: string;
}) {
  const { data: registry, issue } = await readSection<AgentRegistry>(`/projects/${project.id}/agent-registry`,
    data => Array.isArray(data.agents) && Array.isArray(data.skills));
  if (issue) return <SectionReadError label="Agent 与 Skill" issue={issue} />;
  const { agents, skills } = registry;
  const enabled = agents.filter((agent) => agent.enabled).length;
  const manage = project.role === 'owner' && project.status === 'active';
  const projectInput = <input type="hidden" name="projectId" value={project.id} />;
  const allowedRefs = new Set(skills.flatMap(skill => skill.versions.filter(isUsableSkillVersion).map(version => `${skill.id}:${version.version}`)));
  const skillNames = new Map(skills.map(({ id, name }) => [id, name]));

  return (
    <section id="agent-registry" aria-labelledby="agent-heading">
      <header className="page__head">
        <div>
          <p className="eyebrow">{project.code} / AGENT REGISTRY</p>
          <h1 id="agent-heading">Agent 与 Skill</h1>
        </div>
        {!registry.modelConfigured && <span className="module-tag" data-tone="amber">规划 API 未配置</span>}
      </header>
      <section className="panel fleet-distribution" aria-labelledby="agent-status-heading">
        <header className="panel__head"><h2 className="panel__title" id="agent-status-heading"><Icon name="agents" />岗位状态</h2>
          <span className="panel__meta">{agents.length} 个岗位</span></header>
        <StatusDistribution label="Agent 岗位分布" parts={[
          { label: '启用', tone: 'mint', value: enabled },
          { label: '停用', tone: 'mute', value: agents.length - enabled },
        ]} />
      </section>
      <ul className="agent-grid">
        {agents.map((agent) => {
          const active = agent.versions.find(({ version }) => version === agent.activeVersion);
          if (!active) return null;
          const name = agentRoleLabels[agent.role];
          const roleInput = <>{projectInput}<input type="hidden" name="role" value={agent.role} /></>;
          return <li className="panel resource agent-module" key={agent.role} data-enabled={agent.enabled}>
            <header className="resource__head">
              <span className="resource__icon"><Icon name="agents" /></span>
              <div><h2>{name}</h2><small>{active.model || '默认模型'}</small></div>
              <span className="worker-status" data-status={agent.enabled ? 'online' : undefined}>{agent.enabled ? '已启用' : '已停用'}</span>
            </header>
            <div className="module-tags">
              <span className="module-tag">v{active.version}</span>
              {active.skills.slice(0, 3).map(({ id, version }) => <span className="module-tag" key={id}>
                {skillNames.get(id) ?? 'Skill'} · v{version}
              </span>)}
              {active.skills.length > 3 && <span className="module-tag">+{active.skills.length - 3} Skill</span>}
            </div>
            <footer className="module-foot">
              <span>{active.skills.length} 个 Skill</span>
              <ActionDialog title={`${name} · Agent`} actionKey={`agent:${agent.role}`} trigger={manage ? '配置' : '详情'}>
                <dl className="modal-facts">
                  <div><dt>模型</dt><dd>{active.model || '默认模型'}</dd></div>
                  <div><dt>当前版本</dt><dd>v{active.version}</dd></div>
                  <div><dt>状态</dt><dd>{agent.enabled ? '已启用' : '已停用'}</dd></div>
                  <div><dt>Skill</dt><dd>{active.skills.map(({ id, version }) => `${skillNames.get(id) ?? 'Skill'} v${version}`).join('、') || '—'}</dd></div>
                </dl>
                <details className="subdrawer">
                  <summary>岗位指令</summary>
                  <div className="drawer-body"><p className="description">{agent.template}</p>
                    {!manage && active.instructions && <p className="description">{active.instructions}</p>}
                  </div>
                </details>
                {manage && <>
                  <div className="modal-group modal-group--inline">
                    <form action={updateAgent}>
                      {roleInput}<input type="hidden" name="enabled" value={String(!agent.enabled)} />
                      <button className="secondary" name="operation" value="toggle">{agent.enabled ? '停用 Agent' : '启用 Agent'}</button>
                    </form>
                    {agent.versions.length > 1 && <form className="inline-fields" action={updateAgent}>
                      {roleInput}
                      <label>历史版本<select name="version" defaultValue={active.version} key={active.version}>
                        {agent.versions.map(({ version, model, skills: refs }) => {
                          const unavailable = refs.some(ref => !allowedRefs.has(`${ref.id}:${ref.version}`));
                          return <option key={version} value={version} disabled={unavailable}>
                            v{version}{model && ` · ${model}`}{unavailable && ' · 技能版本不可用'}
                          </option>;
                        })}
                      </select></label>
                      <button className="secondary" name="operation" value="activate">启用所选版本</button>
                    </form>}
                  </div>
                  <form className="fields modal-group" action={updateAgent} key={active.version}>
                    <h3>发布新版本</h3>
                    {roleInput}
                    <label>模型标识<input name="model" maxLength={100} defaultValue={active.model} /></label>
                    <label>项目指令<textarea name="instructions" maxLength={8000} defaultValue={active.instructions} /></label>
                    {skills.length > 0 && <fieldset className="check-grid"><legend>关联 Skill</legend>
                      {skills.map((skill) => {
                        const linked = active.skills.find(({ id }) => id === skill.id);
                        return <label key={skill.id}>{skill.name}{!skill.enabled && '（停用）'}
                          <select name="skills" defaultValue={linked ? `${skill.id}:${linked.version}` : ''}>
                            <option value="">无</option>
                            {skill.versions.map(version => <option key={version.version} value={`${skill.id}:${version.version}`}
                              disabled={!isUsableSkillVersion(version)}>v{version.version} · {skillStatuses[version.status]}</option>)}
                          </select>
                        </label>;
                      })}
                    </fieldset>}
                    <div className="form-actions"><button name="operation" value="publish">发布 Agent 版本</button></div>
                  </form>
                </>}
              </ActionDialog>
            </footer>
          </li>;
        })}
      </ul>
      {(skills.length > 0 || manage) && <section className="skill-library" aria-labelledby="skill-heading">
        <header className="panel__head">
          <h2 className="panel__title" id="skill-heading"><Icon name="layers" />Skill 库 <em>{skills.length}</em></h2>
          {manage && <ActionDialog title="新建 Skill" actionKey="skill-create">
            <form className="fields" action={updateSkill}>
              {projectInput}
              <label>名称<input name="name" maxLength={100} required /></label>
              <label>指令<textarea name="instructions" maxLength={4000} required /></label>
              <div className="form-actions"><button>创建 Skill</button></div>
            </form>
          </ActionDialog>}
        </header>
        {skills.length ? <ul className="agent-grid">{skills.map((skill) => (
          <li className="panel resource" key={skill.id}>
            <header className="resource__head">
              <span className="resource__icon"><Icon name="layers" /></span>
              <div><h3>{skill.name}</h3><small>{skill.versions.length} 个版本</small></div>
              <span className="worker-status" data-status={skill.enabled ? 'online' : undefined}>{skill.enabled ? '已启用' : '已停用'}</span>
            </header>
            <footer className="module-foot">
              <span>v{skill.versions[0]?.version ?? '—'}</span>
              <ActionDialog title={`${skill.name} · Skill`} actionKey={`skill:${skill.id}`} openOnLoad={selectedSkill === skill.id} trigger={manage ? '配置' : '详情'}>
                <div className="skill-versions"><h3>版本记录</h3>
                  {selectedSkill === skill.id && !selectedVersion && <SkillFeedback result={skillResult} />}
                  <ul className="member-list">{skill.versions.map(version => <SkillVersionEntry key={version.version} version={version}
                    id={skill.id} projectId={project.id} manage={manage}
                    result={selectedSkill === skill.id && selectedVersion === String(version.version) ? skillResult : undefined} />)}</ul>
                </div>
                {manage && <>
                  <form className="modal-group" action={updateSkill}>
                    {projectInput}<input type="hidden" name="skillId" value={skill.id} />
                    <input type="hidden" name="enabled" value={String(!skill.enabled)} />
                    <button className="secondary" name="operation" value="toggle">{skill.enabled ? '停用 Skill' : '启用 Skill'}</button>
                  </form>
                  <form className="fields modal-group" action={updateSkill} key={skill.versions[0]?.version}>
                    {projectInput}<input type="hidden" name="skillId" value={skill.id} />
                    <label>新版本指令<textarea name="instructions" maxLength={4000} defaultValue={skill.versions[0]?.instructions} required /></label>
                    <div className="form-actions"><button name="operation" value="publish">发布 Skill 版本</button></div>
                  </form>
                </>}
              </ActionDialog>
            </footer>
          </li>
        ))}</ul> : <p className="empty">暂无 Skill</p>}
      </section>}
    </section>
  );
}

const planStates: Record<AgentPlan['state'], string> = {
  queued: '等待运行', running: '运行中', failed: '失败', completed: '已生成方案', cancelled: '已结束',
};

const fieldLabels: Record<string, string> = {
  objective: '目标', constraints: '约束与待确认事项', title: '标题', userStory: '用户故事',
  requirements: '需求', acceptanceCriteria: '验收条件', developer: '开发角色',
  steps: '实施步骤', risks: '风险', testApproach: '验证思路',
};

export function PlanProgress({ projectId, plan, canRetry, showDiagnosis }: {
  projectId: string; plan: AgentPlan; canRetry: boolean; showDiagnosis: boolean;
}) {
  const diagnosis = showDiagnosis && plan.state === 'failed' && plan.error === 'planning_step_failed'
    ? planningFailureMessages[isPlanningFailureCategory(plan.failureCategory) ? plan.failureCategory : 'unknown']
    : null;
  return (
    <section aria-labelledby="agent-plan-heading" className="plan-block">
      <header className="plan-head">
        <h4 id="agent-plan-heading">Agent 规划</h4>
        <span className="badge" data-status={plan.state}>{planStates[plan.state]}</span>
      </header>
      {plan.requirement && <>
        <p>需求来源 · <a href={plan.requirement.referenceUrl} rel="noreferrer">{plan.requirement.title}</a></p>
        <details>
          <summary>规划使用的批准摘录</summary>
          <p className="description">{plan.requirement.excerpt}</p>
          <small>登记人 · {plan.requirement.approvedBy}</small>
        </details>
      </>}
      <p role="status">{planStates[plan.state]}{plan.stage && plan.state !== 'cancelled' && ` · ${agentRoleLabels[plan.stage]}`}</p>
      {(plan.state === 'queued' || plan.state === 'running') && <RefreshExecution />}
      {diagnosis && <p><strong>{diagnosis.label}</strong> · {diagnosis.hint}</p>}
        {Boolean(plan.knowledge?.length) && <details>
          <summary>本次规划使用的项目知识</summary>
          <ul>{plan.knowledge?.map(version => <li key={version.id}>
            <a href={`/?project=${projectId}&task=${plan.taskId}&section=knowledge&knowledgeHistory=1&knowledgeEntry=${version.entryId}&knowledgeVersion=${version.id}#project-knowledge`}>
              {version.title} · v{version.version}
            </a>
            <p className="description">{version.excerpt}</p>
          </li>)}</ul>
        </details>}
      {plan.state === 'failed' && <p>当前阶段未生成可用结果。重试将从该阶段继续。</p>}
      {plan.state === 'failed' && canRetry && <form action={retryAgentPlan}>
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="taskId" value={plan.taskId} />
        <button className="secondary">重试规划</button>
      </form>}
      {plan.steps.map(({ role, version, model, output }) => (
        <details key={role} open={role === 'ARCHITECT'}>
          <summary>{agentRoleLabels[role]} · v{version} · {model}</summary>
          <dl>
            {Object.entries(output).map(([field, value]) => (
              <div key={field}>
                <dt><strong>{fieldLabels[field]}</strong></dt>
                <dd>{Array.isArray(value) ? <ul>{value.map((text, index) => <li key={index}>{text}</li>)}</ul>
                  : field === 'developer' ? agentRoleLabels[value as keyof typeof agentRoleLabels] : value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ))}
    </section>
  );
}
