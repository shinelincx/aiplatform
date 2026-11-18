import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { GitHubApp } from '../src/github';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('lists authorized repositories and narrows the branch token to one repository', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  vi.stubEnv('GITHUB_APP_ID', '1234');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());

  const mock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: 'metadata-only' }))
    .mockResolvedValueOnce(Response.json({ repositories: [
      { id: 42, owner: { login: 'org' }, name: 'project', html_url: 'https://github.com/org/project', default_branch: 'main' },
      { id: 43, owner: { login: 'org' }, name: 'archived', archived: true },
    ] }))
    .mockResolvedValueOnce(Response.json({ token: 'repo-only' }))
    .mockResolvedValueOnce(Response.json({ name: 'release/v1' }))
    .mockResolvedValueOnce(Response.json({ token: 'pull-read' }))
    .mockResolvedValueOnce(Response.json({ number: 13, merged: true, base: { repo: { id: 42 } } }))
    .mockResolvedValueOnce(Response.json({ token: 'pull-read' }))
    .mockResolvedValueOnce(Response.json({ number: 13, merged: true, base: { repo: { id: 43 } } }))
    .mockResolvedValueOnce(Response.json([
      { id: 7, account: { login: 'org' }, suspended_at: null, permissions: { contents: 'write', pull_requests: 'write' } },
      { id: 8, account: { login: 'read-only' }, suspended_at: null, permissions: { contents: 'write', pull_requests: 'read' } },
      { id: 9, account: { login: 'suspended' }, suspended_at: '2026-01-01T00:00:00Z',
        permissions: { contents: 'write', pull_requests: 'write' } },
    ]));
  vi.stubGlobal('fetch', mock);

  const github = new GitHubApp();
  const [repository] = await github.repositories(7);
  expect(repository).toMatchObject({ id: 42, fullName: 'org/project' });
  await github.verifyBranch(7, repository, 'release/v1');

  const [tokenEndpoint, tokenRequest] = mock.mock.calls[0];
  expect(tokenEndpoint).toBe('https://api.github.com/app/installations/7/access_tokens');
  expect(JSON.parse(String(tokenRequest?.body))).toEqual({ permissions: { metadata: 'read' } });
  const [header, payload, signature] = new Headers(tokenRequest?.headers)
    .get('Authorization')!.slice('Bearer '.length).split('.');
  expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ iss: '1234' });
  expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey,
    Buffer.from(signature, 'base64url'))).toBe(true);
  expect(JSON.parse(String(mock.mock.calls[2][1]?.body))).toEqual({
    repository_ids: [42], permissions: { contents: 'read' },
  });
  expect(mock.mock.calls[3][0]).toBe('https://api.github.com/repos/org/project/branches/release%2Fv1');
  expect(new Headers(mock.mock.calls[3][1]?.headers).get('Authorization')).toBe('Bearer repo-only');
  await expect(github.readPull(7, 42, repository.fullName, 13)).resolves.toMatchObject({ number: 13, merged: true });
  await expect(github.readPull(7, 42, repository.fullName, 13)).rejects.toThrow('does not match');
  expect(JSON.parse(String(mock.mock.calls[4][1]?.body))).toEqual({
    repository_ids: [42], permissions: { contents: 'read' },
  });
  expect(mock.mock.calls[5][0]).toBe('https://api.github.com/repos/org/project/pulls/13');
  expect(mock.mock.calls[5][1]?.method).toBe('GET');
  expect(new Headers(mock.mock.calls[5][1]?.headers).get('Authorization')).toBe('Bearer pull-read');
  expect(await github.installations()).toEqual([
    { id: 7, account: 'org', canPublish: true },
    { id: 8, account: 'read-only', canPublish: false },
  ]);
});

it('requests delivery-only permissions and recovers a draft creation after a lost response', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  vi.stubEnv('GITHUB_APP_ID', '1234');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const branch = 'ado/2cc800da-1fc0-4c48-8499-d0022c36d136';
  const sha = '5'.repeat(40);
  const pull = { number: 13, html_url: 'https://github.com/org/project/pull/13', state: 'open',
    head: { ref: branch, sha }, base: { ref: 'main' }, updated_at: '2026-01-02T00:00:00Z' };
  const mock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: 'scoped-write' }))
    .mockResolvedValueOnce(Response.json([]))
    .mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValueOnce(Response.json([pull]));
  vi.stubGlobal('fetch', mock);
  const github = new GitHubApp();
  const token = await github.deliveryToken(7, 42);
  expect(await github.draftPull(token, 'org/project', branch, 'main', sha, 'Candidate', 'Verified')).toEqual({
    number: 13, url: pull.html_url, state: 'open', updatedAt: pull.updated_at,
  });
  expect(JSON.parse(String(mock.mock.calls[0][1]?.body))).toEqual({
    repository_ids: [42], permissions: { contents: 'write', pull_requests: 'write' },
  });
  expect(JSON.parse(String(mock.mock.calls[2][1]?.body))).toMatchObject({ head: branch, base: 'main', draft: true });
  expect(mock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
});
