import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { ThemeProvider } from './theme';
import { themeCookie } from './workspace';
import './styles.css';

export const metadata: Metadata = { title: 'ADO 研发管理平台' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = (await cookies()).get(themeCookie)?.value === 'light' ? 'light' : 'dark';
  return <html lang="zh-CN" data-theme={theme}><body><ThemeProvider initialTheme={theme}>{children}</ThemeProvider></body></html>;
}
