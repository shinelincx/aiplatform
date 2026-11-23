'use client';

import type { Account } from '@ado/shared';
import { useActionState, useState } from 'react';
import { manageAccount, type AccountActionState } from '../../actions';
import { ActionDialog } from '../../console-controls';

const labels = {
  create: { title: '创建账号', submit: '创建账号' },
  edit: { title: '编辑账号', submit: '保存修改' },
  disable: { title: '停用账号', submit: '确认停用' },
};

type AccountDialogProps =
  | { operation: 'create'; account?: never; isSelf?: never }
  | { operation: 'edit' | 'disable'; account: Account; isSelf?: boolean };

function AccountForm({ operation, account, isSelf = false }: AccountDialogProps) {
  const [state, action, pending] = useActionState(
    manageAccount.bind(null, operation, account?.id ?? null, isSelf), {} as AccountActionState,
  );
  const [name, setName] = useState(account?.name ?? '');
  const [email, setEmail] = useState(account?.email ?? '');
  const [role, setRole] = useState<string>(account?.systemRole ?? 'user');

  return <form className="fields" action={action}>
    {operation === 'disable' ? (
      <p>停用 {account.email} 后，该账号将无法登录，现有会话将失效。</p>
    ) : <>
      <label>名称<input name="name" value={name} onChange={(event) => setName(event.target.value)}
        maxLength={100} required /></label>
      <label>邮箱<input name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)}
        maxLength={255} readOnly={operation === 'edit'} required /></label>
      {operation === 'create' && <label>初始密码<input name="password" type="password"
        minLength={12} maxLength={256} autoComplete="new-password" required /></label>}
      <label>平台角色<select name="systemRole" value={role} onChange={(event) => setRole(event.target.value)}>
        <option value="user">普通账号</option>
        <option value="admin">管理员</option>
      </select></label>
    </>}
    {state.error && <p className="feedback" role="alert">{state.error}</p>}
    {state.notice && <p className="notice" role="status">{state.notice}</p>}
    <div className="form-actions">
      <button disabled={pending} className={operation === 'disable' ? 'btn-danger' : undefined}>
        {pending ? '提交中…' : labels[operation].submit}
      </button>
    </div>
  </form>;
}

export function AccountDialog(props: AccountDialogProps) {
  const title = labels[props.operation].title;
  return <ActionDialog title={props.account ? `${title} · ${props.account.email}` : title} trigger={title}>
    <AccountForm {...props} />
  </ActionDialog>;
}
