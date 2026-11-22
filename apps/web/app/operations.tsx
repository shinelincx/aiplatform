import { agentRoleLabels, budgetMonthPattern, type AgentRole, type MonthlyUsage, type Project, type ProjectOperations } from '@ado/shared';
import { saveModelRate, saveMonthlyBudget } from './actions';
import { readSection } from './api-client';
import { SectionReadError } from './section-feedback';

const actions: Record<string, string> = {
  'project.created': '创建项目', 'project.updated': '更新项目', 'project.archived': '归档项目',
  'agent.version_published': '发布 Agent 版本', 'agent.settings_updated': '变更 Agent 配置',
  'skill.version_published': '发布 Skill 版本', 'skill.settings_updated': '变更 Skill 配置',
  'skill.version_evaluated': '登记 Skill 评估', 'skill.version_approved': '批准 Skill 版本',
  'skill.version_rejected': '驳回 Skill 版本',
  'task.approved': '批准任务方案', 'task.rejected': '驳回任务方案', 'execution.reviewed': '人工审核',
  'repository.checks_updated': '更新仓库检查与交付设置', 'delivery.queued': '提交发布请求',
  'execution.worker_reassigned': '调整 Worker 分配',
  'requirement.approved': '登记已批准需求', 'requirement.retired': '撤下需求来源',
  'knowledge.version_created': '登记知识版本', 'knowledge.approved': '批准知识版本', 'knowledge.rejected': '驳回知识版本',
  'knowledge.activated': '启用知识版本', 'knowledge.retired': '撤下知识版本',
  'operations.model_rate_updated': '更新模型费率', 'operations.budget_updated': '更新月度预算',
  'agent.step_completed': '完成规划阶段', 'agent.plan_failed': '规划阶段失败',
  'agent.qa_completed': '提交 QA 意见', 'agent.qa_failed': 'QA 失败', 'task.status_changed': '更新执行状态',
};

function formatTokens(value: string) {
  return BigInt(value).toLocaleString('zh-CN');
}

function displayRate(value: string) {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

const budgetNotices: Record<Exclude<MonthlyUsage['notice'], 'unset'>, string> = {
  unknown: '暂无可用于比较的费用估算',
  below: '低于 80% 提醒线',
  warning: '已达到 80% 预算提醒线',
  reached: '已达到或超出月度预算',
};

export async function Operations({ project, month, task, issue, notice }: {
  project: Project; month?: string; task?: string; issue?: string; notice?: string;
}) {
  const search = typeof month === 'string' && budgetMonthPattern.test(month) ? `?month=${month}` : '';
  const { data: operations, issue: readIssue } = await readSection<ProjectOperations>(`/projects/${project.id}/operations${search}`,
    (data) => Array.isArray(data.usage) && Boolean(data.monthly) &&
      (data.audit === null || Array.isArray(data.audit)) && (data.rates === null || Array.isArray(data.rates)));
  if (readIssue) return <SectionReadError label="项目用量与审计" issue={readIssue} />;
  const budget = operations.monthly;
  return (
    <>
      <h3 id="budget-heading">月度费用与预算</h3>
      <form action="/#budget-heading" className="inline-fields">
        <input type="hidden" name="project" value={project.id} />
        <input type="hidden" name="section" value="operations" />
        {task && <input type="hidden" name="task" value={task} />}
        <label>月份（UTC）<input type="month" name="month" defaultValue={budget.month} pattern="[0-9]{4}-(0[1-9]|1[0-2])" required /></label>
        <button className="secondary">查看月份</button>
      </form>
      <dl className="budget-summary">
        <div><dt>API 文本 token 估算</dt><dd>{budget.estimatedUsd === null ? '暂无估算' : `US$${displayRate(budget.estimatedUsd)}`}</dd></div>
        <div><dt>月度预算</dt><dd>{budget.budgetUsd === null ? '未设置预算' : `US$${displayRate(budget.budgetUsd)}`}</dd></div>
      </dl>
      {budget.notice !== 'unset' && <p><strong>{budgetNotices[budget.notice]}</strong></p>}
      <p className="muted">
        本月可估 {budget.matched}／{budget.records} 条规划与 QA 用量。
        {budget.undated > 0 && `其中 ${budget.undated} 条缺少提供商时间，按入库月份列示。`}
        {' '}估算覆盖可核实的标准档文本 token，账单金额以提供商记录为准。
      </p>
      {project.role === 'owner' && project.status === 'active' && <form action={saveMonthlyBudget} className="fields">
        <input type="hidden" name="projectId" value={project.id} />
        <input type="hidden" name="month" value={budget.month} />
        {task && <input type="hidden" name="task" value={task} />}
        <label>月度预算（USD）
          <input name="amountUsd" inputMode="decimal" maxLength={12} pattern="[0-9]{1,9}(\.[0-9]{1,2})?"
            defaultValue={budget.budgetUsd ?? ''} aria-describedby="budget-help" />
        </label>
        <small id="budget-help">填写正数，最多两位小数。留空并保存可清除额度。</small>
        {issue === 'monthly-budget' && <p role="alert" className="feedback">无法保存预算，请核对金额后重试。</p>}
        {notice === 'budget-saved' && <p role="status">月度预算已保存。</p>}
        <button>保存预算</button>
      </form>}
      <h3>已记录的模型用量（累计）</h3>
      {operations.usage.length ? <ul className="members">{operations.usage.map((usage) => (
        <li key={`${usage.role}/${usage.model}`}>
          <span>{usage.role ? agentRoleLabels[usage.role] : 'Codex'} · {usage.model ?? 'Worker 默认模型'}</span>
          <small>输入 {formatTokens(usage.inputTokens)} · 缓存 {formatTokens(usage.cachedInputTokens)}
            {' '}· 输出 {formatTokens(usage.outputTokens)} tokens</small>
        </li>
      ))}</ul> : <p className="muted">暂无模型用量。</p>}
      {operations.rates && <details open={notice === 'rate-saved' || issue === 'model-rate' ? true : undefined}>
        <summary>模型费率</summary>
        <p className="muted">月度估算按响应创建时生效的版本计价。新费率在保存时生效，单位为每百万 token 的美元金额。</p>
        {notice === 'rate-saved' && <p role="status">费率已保存。</p>}
        {operations.rates.length > 0 && <ul className="members">{operations.rates.map((rate) => (
          <li key={rate.model}>
            <span>{rate.model}{rate.version && ` · v${rate.version}`}</span>
            {rate.sourceUrl && <a href={rate.sourceUrl}>费率来源</a>}
            {rate.effectiveAt && <small>生效 UTC {new Date(rate.effectiveAt).toISOString().slice(0, 19).replace('T', ' ')}</small>}
            <small>输入 {displayRate(rate.inputUsdPerMillion)} · 缓存 {displayRate(rate.cachedInputUsdPerMillion)}
              {' '}· 输出 {displayRate(rate.outputUsdPerMillion)}</small>
          </li>
        ))}</ul>}
        {project.status === 'active' && <form action={saveModelRate} className="fields">
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="month" value={budget.month} />
          {task && <input type="hidden" name="task" value={task} />}
          <label>模型 ID<input name="model" list="usage-models" maxLength={100} required /></label>
          <datalist id="usage-models">
            {[...new Set(operations.usage.map(({ model }) => model))].map((model) =>
              model && <option key={model} value={model} />)}
          </datalist>
          <label>输入费率<input name="inputUsdPerMillion" inputMode="decimal" maxLength={16} required /></label>
          <label>缓存输入费率<input name="cachedInputUsdPerMillion" inputMode="decimal" maxLength={16} required /></label>
          <label>输出费率<input name="outputUsdPerMillion" inputMode="decimal" maxLength={16} required /></label>
          <label>费率来源<input name="sourceUrl" type="url" maxLength={2048} required /></label>
          <button>保存费率</button>
        </form>}
      </details>}
      {operations.audit && <>
        <h3>最近审计记录</h3>
        {operations.audit.length ? <ol className="members">{operations.audit.map((entry) => (
          <li key={entry.id}>
            <div>
              <span>{actions[entry.action] ?? entry.action} · {Object.hasOwn(agentRoleLabels, entry.actor)
                ? agentRoleLabels[entry.actor as AgentRole] : entry.actor}
                {entry.details?.role && ` · ${agentRoleLabels[entry.details.role]}`}
                {entry.details?.version && ` · v${entry.details.version}`}
                {entry.details?.month && ` · ${entry.details.month} UTC · ${entry.details.budgetUsd == null ? '未设置' : `US$${displayRate(entry.details.budgetUsd)}`}`}
                {entry.details?.enabled !== undefined && (entry.details.enabled ? ' · 启用' : ' · 停用')}</span>
              {entry.action !== 'operations.budget_updated' && <small className="description">{entry.resourceId}</small>}
            </div>
            <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</time>
          </li>
        ))}</ol> : <p className="muted">暂无审计记录。</p>}
      </>}
    </>
  );
}
