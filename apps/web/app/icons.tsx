export type IconName = 'agents' | 'arrow' | 'chart' | 'chevron' | 'git' | 'grid' | 'layers' | 'moon' | 'plus' | 'search' | 'shield' | 'sun' | 'tasks' | 'terminal' | 'workers' | 'x';

export function Icon({ name }: { name: IconName }) {
  return <svg className="ic" aria-hidden="true"><use href={`#i-${name}`} /></svg>;
}

export function IconSprite() {
  return (
    <svg className="sprite" aria-hidden="true">
      <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></symbol>
      <symbol id="i-tasks" viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13"/><circle cx="20" cy="12" r="1.4"/></symbol>
      <symbol id="i-agents" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2"/><path d="M5 20c.8-4 3.4-5.6 7-5.6s6.2 1.6 7 5.6"/><path d="M12 3v1.8"/></symbol>
      <symbol id="i-workers" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="6" rx="1"/><rect x="4" y="14" width="16" height="6" rx="1"/><path d="M8 7h.01M8 17h.01M12 7h6M12 17h6"/></symbol>
      <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6z"/><path d="M9 12l2 2 4-4"/></symbol>
      <symbol id="i-chart" viewBox="0 0 24 24"><path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-3"/></symbol>
      <symbol id="i-terminal" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M7 9l3 3-3 3M13 15h4"/></symbol>
      <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/></symbol>
      <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
      <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
      <symbol id="i-git" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="12" r="2.4"/><path d="M6 8.4v7.2M8.4 6H14a4 4 0 014 4v.2"/></symbol>
      <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
      <symbol id="i-chevron" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></symbol>
      <symbol id="i-layers" viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></symbol>
      <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/></symbol>
      <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20.7 15A8.7 8.7 0 0 1 9 3.3 8.8 8.8 0 1 0 20.7 15Z"/></symbol>
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg className="brand__mark" viewBox="0 0 40 40" aria-hidden="true">
        <path d="M20 3l14.7 8.5v17L20 37 5.3 28.5v-17z" className="brand__hex"/>
        <path d="M20 12l7.8 4.5v9L20 30l-7.8-4.5v-9z" className="brand__hex-inner"/>
        <circle cx="20" cy="20" r="2.4" className="brand__dot"/>
      </svg>
  );
}

export function BootMark() {
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="46" className="ring ring--a"/>
        <circle cx="60" cy="60" r="34" className="ring ring--b"/>
        <path d="M60 18l36 21v42l-36 21-36-21V39z" className="hex"/>
        <path d="M60 42l16 9v18l-16 9-16-9V51z" className="hex hex--inner"/>
      </svg>
  );
}
