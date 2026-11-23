import { budgetMonthPattern, type MonthlyUsage, type Project, type ProjectOperations } from '@ado/shared';
import { saveModelRate, saveMonthlyBudget } from './actions';
import { readSection } from './api-client';
import { SectionReadError } from './section-feedback';
import { AuditLog } from './audit-log';
import { ActionDialog } from './console-controls';
import { Icon } from './icons';
import { formatTokens, tokenTotal, UsageChart } from './metrics';

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

export function auditActionLabel(action: string) {
  return Object.hasOwn(actions, action) ? actions[action] : action;
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

export async function Operations({ project, month, task }: { project: Project; month?: string; task?: string }) {
  const search = typeof month === 'string' && budgetMonthPattern.test(month) ? `?month=${month}` : '';
  const { data: operations, issue } = await readSection<ProjectOperations>(`/projects/${project.id}/operations${search}`,
    data => Array.isArray(data.usage) && Boolean(data.monthly)
      && (data.audit === null || Array.isArray(data.audit)) && (data.rates === null || Array.isArray(data.rates)));
  if (issue) return <SectionReadError label="项目用量与审计" issue={issue} />;
  const budget = operations.monthly;
  const periodInputs = <>
    <input type="hidden" name="month" value={budget.month} />
    {task && <input type="hidden" name="task" value={task} />}
  </>;
  const { audit, rates, usage } = operations;
  const models = new Set(usage.map(({ model }) => model));

  return (
    <section id="operations" className="operations-section" aria-labelledby="operations-heading">
      <header className="page__head">
        <div>
          <p className="eyebrow">{project.code} / USAGE LEDGER</p>
          <h1 id="operations-heading">用量与审计</h1>
        </div>
        <div className="page__meta">
          <div className="headstat"><small>累计 TOKENS</small><strong>{formatTokens(tokenTotal(usage))}</strong></div>
          <div className="headstat"><small>模型</small><strong>{models.size}</strong></div>
        </div>
      </header>
      <section className="panel fleet-distribution" aria-labelledby="budget-heading">
        <header className="panel__head">
          <h2 id="budget-heading" className="panel__title"><Icon name="chart" />月度费用与预算</h2>
          {project.role === 'owner' && project.status === 'active' && <ActionDialog title="设置月度预算" actionKey="budget">
            <form action={saveMonthlyBudget} className="fields">
              <input type="hidden" name="projectId" value={project.id} />{periodInputs}
              <label>月度预算（USD）<input name="amountUsd" inputMode="decimal" maxLength={12}
                pattern="[0-9]{1,9}(\.[0-9]{1,2})?" defaultValue={budget.budgetUsd ?? ''} /></label>
              <small>留空并保存可清除额度。</small>
              <div className="form-actions"><button>保存预算</button></div>
            </form>
          </ActionDialog>}
        </header>
        <form action="/#budget-heading" className="inline-fields">
          <input type="hidden" name="project" value={project.id} /><input type="hidden" name="section" value="operations" />
          {task && <input type="hidden" name="task" value={task} />}
          <label>月份（UTC）<input key={budget.month} type="month" name="month" defaultValue={budget.month} required /></label>
          <button className="secondary">查看月份</button>
        </form>
        <dl className="resource__metrics">
          <div><dt>API 文本 token 估算</dt><dd>{budget.estimatedUsd === null ? '暂无估算' : `US$${displayRate(budget.estimatedUsd)}`}</dd></div>
          <div><dt>月度预算</dt><dd>{budget.budgetUsd === null ? '未设置预算' : `US$${displayRate(budget.budgetUsd)}`}</dd></div>
          <div><dt>可估用量</dt><dd>{budget.matched} / {budget.records}</dd></div>
        </dl>
        {budget.notice !== 'unset' && <p className="muted">{budgetNotices[budget.notice]}</p>}
        {budget.undated > 0 && <p className="muted">{budget.undated} 条缺少提供商时间，按入库月份列示。</p>}
        <p className="muted">估算覆盖可核实的标准档文本 token，账单金额以提供商记录为准。</p>
      </section>
      <div className="ogrid operations-grid">
        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title"><Icon name="chart" />模型用量</h2>
            {rates && <ActionDialog title="模型费率" actionKey="rates">
              <p className="muted">US$ / 百万 Tokens</p>
              {rates.length > 0 ? <ul className="rate-list">{rates.map((rate) => (
                <li key={rate.model}>
                  <strong>{rate.model}{rate.version && ` · v${rate.version}`}</strong>
                  {rate.sourceUrl && <a href={rate.sourceUrl}>费率来源</a>}
                  {rate.effectiveAt && <small>生效 UTC {new Date(rate.effectiveAt).toISOString().slice(0, 19).replace('T', ' ')}</small>}
                  <dl className="resource__metrics">
                    <div><dt>输入</dt><dd>{displayRate(rate.inputUsdPerMillion)}</dd></div>
                    <div><dt>缓存</dt><dd>{displayRate(rate.cachedInputUsdPerMillion)}</dd></div>
                    <div><dt>输出</dt><dd>{displayRate(rate.outputUsdPerMillion)}</dd></div>
                  </dl>
                </li>
              ))}</ul> : <p className="empty">暂无费率</p>}
              {project.status === 'active' && <form action={saveModelRate} className="fields">
                <input type="hidden" name="projectId" value={project.id} />{periodInputs}
                <label>模型 ID<input name="model" list="usage-models" maxLength={100} required /></label>
                <datalist id="usage-models">{[...models].map((model) => model && <option key={model} value={model} />)}</datalist>
                <div className="rate-fields">
                  <label>输入费率<input name="inputUsdPerMillion" inputMode="decimal" maxLength={16} required /></label>
                  <label>缓存输入费率<input name="cachedInputUsdPerMillion" inputMode="decimal" maxLength={16} required /></label>
                  <label>输出费率<input name="outputUsdPerMillion" inputMode="decimal" maxLength={16} required /></label>
                </div>
                <label>费率来源<input name="sourceUrl" type="url" maxLength={2048} required /></label>
                <div className="form-actions"><button>保存费率</button></div>
              </form>}
            </ActionDialog>}
          </header>
          <UsageChart usage={usage} />
        </section>
        {audit && <section className="panel">
          <header className="panel__head"><h2 className="panel__title"><Icon name="terminal" />最近审计记录</h2>
            <span className="panel__meta">{audit.length} 条</span></header>
          <AuditLog entries={audit.map((entry) => ({ ...entry, title: auditActionLabel(entry.action) }))} />
        </section>}
      </div>
    </section>
  );
}
