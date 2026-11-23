import { changePassword, updateProfile } from '../../actions';
import { ActionDialog } from '../../console-controls';
import { Icon } from '../../icons';
import { requireSettingsAccount } from '../session';
import { SettingsScreen, type SettingsSearch } from '../screen';

export const metadata = { title: '我的账号 · ADO' };

export default async function Page({ searchParams }: { searchParams: SettingsSearch }) {
  const account = await requireSettingsAccount();
  const admin = account.systemRole === 'admin';
  return <SettingsScreen title="我的账号" searchParams={searchParams}>
    <section className="panel system-profile">
      <header className="panel__head"><h2 className="panel__title"><Icon name="agents" />个人资料</h2>
        <span className="module-tag" data-tone={admin ? 'mint' : 'mute'}>{admin ? '管理员' : '普通账号'}</span>
      </header>
      <dl className="modal-facts">
        <div><dt>名称</dt><dd>{account.name}</dd></div>
        <div><dt>邮箱</dt><dd>{account.email}</dd></div>
      </dl>
      <footer className="system-actions">
        <ActionDialog title="修改名称" actionKey="profile">
          <form action={updateProfile} key={account.name} className="fields">
            <label>名称<input name="name" maxLength={100} defaultValue={account.name} autoComplete="name" required /></label>
            <div className="form-actions"><button>保存名称</button></div>
          </form>
        </ActionDialog>
        <ActionDialog title="修改密码" actionKey="password">
          <form action={changePassword} className="fields">
            <label>当前密码<input type="password" name="currentPassword" maxLength={256} autoComplete="current-password" required /></label>
            <label>新密码<input type="password" name="newPassword" minLength={12} maxLength={256}
              autoComplete="new-password" required /></label>
            <label>确认新密码<input type="password" name="confirmPassword" minLength={12} maxLength={256}
              autoComplete="new-password" required /></label>
            <p className="muted">新密码至少 12 个字符。修改后，所有会话将退出。</p>
            <div className="form-actions"><button>更新密码</button></div>
          </form>
        </ActionDialog>
      </footer>
    </section>
  </SettingsScreen>;
}
