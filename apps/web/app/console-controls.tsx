'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { issues, notices } from './feedback';
import { Icon, type IconName } from './icons';

export function ConsoleClock({ large = false, code }: { large?: boolean; code?: string }) {
  const [time, setTime] = useState('--:--:--');
  useEffect(() => {
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', timeStyle: 'medium' });
    const tick = () => setTime(formatter.format(new Date()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className={large ? 'tele__clock' : 'clock'}>
    <time>{time}</time><small>{code ? `${code} · ` : ''}UTC+8</small>
  </div>;
}

export type ConsoleCommand = {
  label: string;
  hint: string;
  href: string;
  icon: IconName;
};

export function CommandPalette({ commands, createHref }: { commands: ConsoleCommand[]; createHref?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const matches = commands.filter(({ label, hint }) => `${label} ${hint}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    function show() {
      if (document.querySelector('dialog[open]')) return;
      setQuery('');
      setIndex(0);
      dialog.current?.showModal();
      field.current?.focus();
    }

    function shortcuts(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else show();
      }
      if (event.key.toLowerCase() !== 'n' || !createHref || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || document.querySelector('dialog[open]') || (event.target instanceof HTMLElement &&
          (event.target.isContentEditable || event.target.closest('input, textarea, select')))) return;
      event.preventDefault();
      router.push(createHref);
    }

    document.addEventListener('ado:commands', show);
    document.addEventListener('keydown', shortcuts);
    return () => {
      document.removeEventListener('ado:commands', show);
      document.removeEventListener('keydown', shortcuts);
    };
  }, [createHref, router]);

  function select(href: string) {
    dialog.current?.close();
    router.push(href);
  }

  function move(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || !matches.length) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      select(matches[index].href);
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
    setIndex(next);
    results.current?.children.item(next)?.scrollIntoView({ block: 'nearest' });
  }

  return <dialog ref={dialog} className="palette" aria-label="指令面板"
    onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="palette__panel">
      <div className="palette__field">
        <Icon name="search" />
        <input ref={field} type="search" role="combobox" aria-label="搜索页面或执行操作"
          aria-expanded="true" aria-controls="command-results" aria-autocomplete="list"
          aria-activedescendant={matches.length ? `command-${index}` : undefined}
          placeholder="搜索页面或执行操作…" autoComplete="off" spellCheck={false} value={query}
          onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={move} />
        <button type="button" className="icon-button" aria-label="关闭指令面板" onClick={() => dialog.current?.close()}>
          <Icon name="x" />
        </button>
      </div>
      <ul ref={results} className="palette__list" id="command-results" role="listbox">
        {matches.map((command, position) => <li key={command.href} id={`command-${position}`} role="option"
          aria-selected={position === index}>
          <button type="button" tabIndex={-1} onPointerMove={() => setIndex(position)} onClick={() => select(command.href)}>
            <Icon name={command.icon} /><span>{command.label}</span><small>{command.hint}</small>
          </button>
        </li>)}
      </ul>
      {!matches.length && <p className="empty" role="status">没有匹配的指令。</p>}
      <div className="palette__foot"><span>↑ ↓ 选择</span><span>↵ 执行</span><span>Esc 关闭</span></div>
    </div>
  </dialog>;
}

export function CommandButton({ quick = false }: { quick?: boolean }) {
  return <button type="button" className={quick ? 'quickbtn' : 'cmdbtn'} aria-label="打开指令面板"
    onClick={() => document.dispatchEvent(new Event('ado:commands'))}>
    <Icon name={quick ? 'terminal' : 'search'} /><span>{quick ? '指令面板' : '指令'}</span><kbd>Ctrl K</kbd>
  </button>;
}

export function ProjectSwitcher({ projects, value }: {
  projects: { href: string; code: string; name: string }[]; value: string;
}) {
  const router = useRouter();
  return <div className="project-switch">
    <select aria-label="切换项目" value={value} onChange={(event) => router.push(event.target.value)}>
      {!value && <option value="" disabled>选择项目</option>}
      {projects.map(({ href, code, name }) => <option key={href} value={href}>{code} · {name}</option>)}
    </select>
  </div>;
}

export function MobileMenu({ children }: { children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  return <details ref={menu} className="mobile-menu"
    onKeyDown={(event) => {
      if (event.key === 'Escape' && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector('summary')?.focus();
      }
    }}>
    <summary className="icon-button" aria-label="工作区导航"><Icon name="grid" /></summary>
    <div className="mobile-menu__body" onClick={(event) => {
      if (event.target instanceof Element && event.target.closest('a') && menu.current) menu.current.open = false;
    }}>{children}</div>
  </details>;
}

export function ActionDialog({ title, trigger, children, className = 'utility-btn', actionKey, openOnLoad = false, closeHref, renderClosed = false }: {
  title: string; trigger?: ReactNode; children: ReactNode; className?: string; actionKey?: string;
  openOnLoad?: boolean; closeHref?: string; renderClosed?: boolean;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const router = useRouter();
  const query = useSearchParams();
  const [localOpen, setLocalOpen] = useState(false);
  const [dismissedRequest, setDismissedRequest] = useState<string | null>(null);
  const routed = Boolean(actionKey && query.get('dialog') === actionKey);
  const request = routed || openOnLoad ? query.toString() : null;
  const open = localOpen || (request !== null && request !== dismissedRequest);
  const issue = query.get('issue');
  const notice = query.get('notice');
  const message = routed && issue && Object.hasOwn(issues, issue) ? issues[issue] : undefined;
  const success = routed && notice && Object.hasOwn(notices, notice) ? notices[notice] : undefined;

  useEffect(() => {
    if (open && panel.current && !panel.current.open) panel.current.showModal();
  }, [open]);

  function dismiss() {
    setLocalOpen(false);
    opener.current?.focus({ preventScroll: true });
    if (request === null) return;
    setDismissedRequest(request);
    const clean = new URLSearchParams(query);
    for (const field of ['dialog', 'issue', 'notice', 'requirementResult', 'skillResult', 'skill', 'skillVersion']) clean.delete(field);
    const search = clean.toString();
    router.replace(openOnLoad && closeHref ? closeHref : `${location.pathname}${search ? `?${search}` : ''}${location.hash}`, { scroll: false });
  }

  return <>
    <button ref={opener} type="button" className={className} aria-haspopup="dialog"
      onClick={() => { setDismissedRequest(null); setLocalOpen(true); }}>
      {trigger ?? title}
    </button>
    {(open || renderClosed) && <dialog ref={panel} className="action-modal" aria-labelledby={titleId}
      onClose={(event) => { if (event.target === event.currentTarget) dismiss(); }}
      onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
      <div className="action-modal__inner">
        <header className="action-modal__head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label="关闭弹窗" onClick={() => panel.current?.close()}>
            <Icon name="x" />
          </button>
        </header>
        <div className="action-modal__body">
          {message && <p className="feedback" role="alert">{message}</p>}
          {success && <p className="notice" role="status">{success}</p>}
          {children}
        </div>
      </div>
    </dialog>}
  </>;
}

export function TaskDrawer({ children, closeHref, label }: { children: ReactNode; closeHref: string; label: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  useLayoutEffect(() => {
    const panel = dialog.current;
    panel?.showModal();
    return () => panel?.close();
  }, []);

  function dismiss() {
    dialog.current?.close();
    router.push(closeHref, { scroll: false });
  }

  return <dialog ref={dialog} className="task-overlay" aria-label={label}
    onCancel={(event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      dismiss();
    }}
    onClick={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
    <div className="task-overlay__inner">
      <header className="task-overlay__bar">
        <span className="eyebrow">{label}</span>
        <Link href={closeHref} scroll={false} className="icon-button" aria-label="关闭任务面板"
          onClick={(event) => {
            if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) dialog.current?.close();
          }}><Icon name="x" /></Link>
      </header>
      {children}
    </div>
  </dialog>;
}
