import { createHash } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { maxPatchBytes } from '@ado/shared';

type RevisionSource = { baseCommit: string; bytes: Buffer };

export type RevisionLoader = (runId: string, signal: AbortSignal) => Promise<RevisionSource>;

export async function fetchRevisionArtifact(url: URL, authorization: string, signal: AbortSignal): Promise<RevisionSource> {
  const response = await fetch(url, {
    headers: { Authorization: authorization }, redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  const length = response.headers.get('Content-Length') ?? '';
  const size = Number(length);
  const baseCommit = response.headers.get('X-ADO-Base-Commit') ?? '';
  if (!response.ok || !response.body || response.headers.get('Content-Type') !== 'application/octet-stream'
    || !/^[0-9]+$/.test(length) || size < 1 || size > maxPatchBytes || !/^[0-9a-f]{40}$/.test(baseCommit)) {
    await response.body?.cancel();
    throw new Error('Invalid revision artifact response');
  }

  const bytes = Buffer.alloc(size);
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > size) throw new Error('Revision artifact exceeds its declared size');
      bytes.set(value, received);
      received += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (received !== size) throw new Error('Incomplete revision artifact');
  return { baseCommit, bytes };
}

export async function restoreRevision(source: RevisionSource, baseCommit: string, patchHash: string, jobRoot: string,
  git: (args: string[]) => Promise<{ stdout: string }>) {
  const { bytes } = source;
  if (source.baseCommit !== baseCommit || bytes.length < 1 || bytes.length > maxPatchBytes
    || createHash('sha256').update(bytes).digest('hex') !== patchHash) {
    throw new Error('Revision artifact does not match the expected base or digest');
  }
  const file = join(jobRoot, 'revision.patch');
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await git(['apply', '--check', '--index', '--', file]);
    await git(['apply', '--index', '--', file]);
    const { stdout } = await git(['write-tree']);
    return stdout.trim();
  } finally {
    await unlink(file);
  }
}
