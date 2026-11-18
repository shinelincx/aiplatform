import { cookies } from 'next/headers';

export const sessionCookie = 'ado_session';

export async function api(path: string, options: RequestInit = {}, authenticated = true) {
  const token = authenticated ? (await cookies()).get(sessionCookie)?.value : undefined;
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body) headers.set('Content-Type', 'application/json');
  return fetch(new URL(path, process.env.API_BASE_URL ?? 'http://127.0.0.1:3101'), {
    ...options,
    headers,
    cache: 'no-store',
    signal: options.signal ?? AbortSignal.timeout(8000),
  });
}

export async function read<T>(path: string): Promise<T | null> {
  const response = await api(path);
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`API returned ${response.status} for ${path}`);
  return response.json() as Promise<T>;
}
