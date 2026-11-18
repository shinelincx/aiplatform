import { checkApiHealth } from '@ado/shared';

async function main() {
  const reachable = await checkApiHealth(process.env.API_BASE_URL ?? 'http://127.0.0.1:3101');
  console.log(JSON.stringify({
    service: 'ado-worker',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    apiReachable: reachable,
  }));
  process.exitCode = reachable ? 0 : 1;
}

void main();
