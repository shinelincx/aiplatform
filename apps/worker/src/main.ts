import { checkApiHealth } from '@ado/shared';
import { runAgent } from './agent';

async function main() {
  const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:3101';
  const workerId = process.env.ADO_WORKER_ID;
  const token = process.env.ADO_WORKER_TOKEN;
  if (workerId !== undefined || token !== undefined) {
    const stop = new AbortController();
    process.once('SIGINT', () => stop.abort());
    process.once('SIGTERM', () => stop.abort());
    await runAgent(baseUrl, workerId, token, stop.signal);
    return;
  }
  const reachable = await checkApiHealth(baseUrl);
  console.log(JSON.stringify({
    service: 'ado-worker',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    apiReachable: reachable,
  }));
  process.exitCode = reachable ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Worker stopped');
  process.exitCode = 1;
});
