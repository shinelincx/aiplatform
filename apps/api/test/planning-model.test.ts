import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAssignment } from '@ado/shared';
import { openAIPlanningModel } from '../src/planning-model';

const agent: AgentAssignment = {
  role: 'PROJECT_DIRECTOR', model: 'fixture-model', version: 1, instructions: '', skills: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('planning provider failures', () => {
  it('does not read the provider error body or attach it to a classified error', async () => {
    vi.stubEnv('ADO_AGENT_API_KEY', 'private-key-fixture');
    const response = Response.json({ error: { message: 'private-body-fixture' } }, { status: 403 });
    const readBody = vi.spyOn(response, 'json');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = openAIPlanningModel.generate('PROJECT_DIRECTOR', agent, {});
    await expect(result).rejects.toMatchObject({ category: 'credentials_or_permissions', message: 'credentials_or_permissions' });
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(readBody).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  });

  it('classifies a timeout while reading the response as a network failure', async () => {
    vi.stubEnv('ADO_AGENT_API_KEY', 'private-key-fixture');
    const response = Response.json({});
    vi.spyOn(response, 'json').mockRejectedValue(new DOMException('private-body-fixture', 'TimeoutError'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(openAIPlanningModel.generate('PROJECT_DIRECTOR', agent, {}))
      .rejects.toMatchObject({ category: 'network', message: 'network' });
  });

  it('classifies an unrecognized transport error without propagating its message', async () => {
    vi.stubEnv('ADO_AGENT_API_KEY', 'private-key-fixture');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private-body-fixture')));

    await expect(openAIPlanningModel.generate('PROJECT_DIRECTOR', agent, {}))
      .rejects.toMatchObject({ category: 'unknown', message: 'unknown' });
  });
});
