
const revision = /^[0-9a-f]{40}$/;
const phases = ['claim', 'result'];

export async function POST(request: Request, { params }: { params: Promise<{ release?: string[] }> }) {
  const { release = [] } = await params;
  if (release.length && !(release.length === 2 && revision.test(release[0]) && phases.includes(release[1]))) {
    return new Response(null, { status: 404 });
  }
  const authorization = request.headers.get('authorization');
  if (!authorization) return new Response(null, { status: 401 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
  }
  try {
    const response = await fetch(new URL('/github/staging-releases' + release.map(part => '/' + part).join(''),
      process.env.API_BASE_URL ?? 'http://127.0.0.1:3101'), {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: Buffer.concat(chunks), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(7000),
    });
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response(null, { status: 502 });
  }
}
