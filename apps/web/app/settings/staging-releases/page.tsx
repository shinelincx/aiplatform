
import { stagingRepository, type StagingRelease } from '@ado/shared';
import { decideStagingRelease } from '../../actions';
import { readSection } from '../../api-client';
import { SubmitButton } from '../../task-feedback';
import { RefreshExecution } from '../../refresh-execution';
import { SectionReadError } from '../../section-feedback';
import { stagingReleaseLabels, stagingRunUrl } from '../../staging-release-status';
import { SettingsScreen, type SettingsSearch } from '../screen';
import { requireSettingsAdmin } from '../session';

export const metadata = { title: '预发布审批 · ADO' };
const repository = 'https://github.com/' + stagingRepository;

export default async function Page({ searchParams }: { searchParams: SettingsSearch }) {
  await requireSettingsAdmin();
  const result = await readSection<{ configured: boolean; releases: StagingRelease[] }>('/staging-releases',
    data => Array.isArray(data.releases));
  return <SettingsScreen title="系统任务 · 预发布审批" searchParams={searchParams}>
    {result.issue ? <SectionReadError label="预发布审批" issue={result.issue} /> : <>
      {!result.data.configured && <p className="feedback">发布工作流尚未配置。</p>}
      {result.data.releases.some(({ state }) => state === 'approved' || state === 'deploying') && <RefreshExecution intervalMs={10000} />}
      {!result.data.releases.length && <p className="empty">暂无需要审批的预发布任务。</p>}
      <div className="fields">
        {result.data.releases.map(release => <section className="panel" key={release.sha}>
          <header className="panel__head">
            <h2 className="panel__title">协调发布 <a href={repository + '/commit/' + release.sha}>{release.sha.slice(0, 12)}</a></h2>
            <span className="module-tag" data-tone={release.state === 'succeeded' ? 'mint' : release.state === 'failed' ? 'rose' : 'amber'}>
              {stagingReleaseLabels[release.state]}
            </span>
          </header>
          <dl className="modal-facts">
            <div><dt>提交</dt><dd><code>{release.sha}</code></dd></div>
            <div><dt>当前版本</dt><dd><code>{release.baseSha}</code></dd></div>
            <div><dt>镜像</dt><dd><code>{release.image}</code></dd></div>
            <div><dt>关联 PR</dt><dd>{release.pulls.length ? release.pulls.map(pull =>
              <span key={pull}><a href={repository + '/pull/' + pull}>#{pull}</a>{' '}</span>) : '直接提交'}</dd></div>
            <div><dt>迁移文件</dt><dd><ul>{release.files.map(file => <li key={file}><a
              href={repository + '/compare/' + release.baseSha + '...' + release.sha}>{file}</a></li>)}</ul></dd></div>
            <div><dt>备份计划</dt><dd>排空队列、暂停写入，备份数据库和对象存储，校验备份后执行迁移。</dd></div>
            <div><dt>构建记录</dt><dd><a href={stagingRunUrl(release.sourceRun)}>查看已发布镜像的 CI</a></dd></div>
            {release.decidedBy && release.decidedAt && <div><dt>审批人</dt><dd>{release.decidedBy} · {new Date(release.decidedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</dd></div>}
            {release.note && <div><dt>审批意见</dt><dd>{release.note}</dd></div>}
            {release.deploymentRun && <div><dt>部署记录</dt><dd><a href={stagingRunUrl(release.deploymentRun)}>查看部署日志</a></dd></div>}
          </dl>
          {release.state === 'pending' && <form className="fields" action={decideStagingRelease}>
            <input type="hidden" name="sha" value={release.sha} />
            <label>审批意见（驳回时必填）<textarea name="note" maxLength={500} /></label>
            <div className="form-actions">
              <SubmitButton name="decision" value="rejected" className="secondary" pendingLabel="正在提交…">驳回</SubmitButton>
              <SubmitButton name="decision" value="approved" disabled={!result.data.configured} pendingLabel="正在提交…">批准并触发预发布</SubmitButton>
            </div>
          </form>}
          {release.state === 'approved' && <form action={decideStagingRelease}>
            <input type="hidden" name="sha" value={release.sha} />
            <SubmitButton name="decision" value="retry" disabled={!result.data.configured} className="secondary" pendingLabel="正在提交…">重新触发部署</SubmitButton>
          </form>}
        </section>)}
      </div>
    </>}
  </SettingsScreen>;
}
