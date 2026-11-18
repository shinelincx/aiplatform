import { afterEach, expect, it, vi } from 'vitest';
import { checkApiHealth } from '../src';

afterEach(() => vi.unstubAllGlobals());

it.each([
  [200, { service: 'ado-api', status: 'ok' }, true],
  [200, { service: 'other', status: 'ok' }, false],
  [200, null, false],
  [503, { service: 'ado-api', status: 'ok' }, false],
])('checks the health response %i %j', async (status, body, expected) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })));
  expect(await checkApiHealth('http://localhost')).toBe(expected);
});

it('reports an unreachable API as offline', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  expect(await checkApiHealth('http://localhost')).toBe(false);
});
