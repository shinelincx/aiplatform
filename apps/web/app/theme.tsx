'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { Icon } from './icons';
import { themeCookie } from './workspace';

export type Theme = 'dark' | 'light';

const ThemeContext = createContext({ theme: 'dark' as Theme, toggle: () => {} });

export function ThemeProvider({ initialTheme, children }: { initialTheme: Theme; children: ReactNode }) {
  const [theme, setTheme] = useState(initialTheme);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${themeCookie}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    setTheme(next);
  }

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle() {
  const { theme, toggle } = useContext(ThemeContext);
  return <button type="button" className="icon-button theme-toggle" aria-label={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
    title={theme === 'dark' ? '亮色模式' : '暗色模式'} onClick={toggle}>
    <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
  </button>;
}
