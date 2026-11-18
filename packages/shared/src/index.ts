export interface ApiHealth {
  service: 'ado-api';
  status: 'ok';
}

export async function checkApiHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', baseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.service === 'ado-api' && health?.status === 'ok';
  } catch {
    return false;
  }
}
