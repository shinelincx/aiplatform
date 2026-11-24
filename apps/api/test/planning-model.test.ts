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

describe('planning provider', () => {
  it.each([
    [undefined, undefined],
    ['none', { effort: 'none' }],
    ['high', { effort: 'high' }],
  ] as const)('sends the configured reasoning effort %s', async (reasoningEffort, reasoning) => {
    vi.stubEnv('ADO_AGENT_API_KEY', 'private-key-fixture');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"objective":"Fixture","constraints":[]}' }] }],
    }));
    vi.stubGlobal('fetch', fetch);

    await openAIPlanningModel.generate('PROJECT_DIRECTOR', { ...agent, reasoningEffort }, {});

    const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(payload.reasoning).toEqual(reasoning);
  });

  it('retains valid metering and UTC provider time when structured output cannot be used', async () => {
    vi.stubEnv('ADO_AGENT_API_KEY', 'private-key-fixture');
    const fetch = vi.fn().mockResolvedValue(Response.json({
      model: 'fixture-model', created_at: Date.parse('2040-10-31T23:59:59.500Z') / 1000,
      service_tier: 'default', status: 'incomplete',
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10 },
    }));
    vi.stubGlobal('fetch', fetch);

    await expect(openAIPlanningModel.generate('PROJECT_DIRECTOR', agent, {}))
      .rejects.toMatchObject({
        category: 'invalid_structured_output',
        usage: { model: 'fixture-model', inputTokens: 100, cachedInputTokens: 20, outputTokens: 10,
          providerCreatedAt: '2040-10-31T23:59:59.500Z', serviceTier: 'default' },
      });
    expect(JSON.parse(fetch.mock.calls[0][1].body).service_tier).toBe('auto');
  });
  it('does not read the provider error body or attach it to a classified error', async () => {
    vi.stubEnv('ADO_AGENT_API_KEY', 'private-key-fixture');
    const response = Response.json({ error: { message: 'private-body-fixture' } }, { status: 403 });
    const readBody = vi.spyOn(response, 'json');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = openAIPlanningModel.generate('PROJECT_DIRECTOR', agent, {});
    await expect(result).rejects.toMatchObject({
      category: 'credentials_or_permissions', message: 'credentials_or_permissions', httpStatus: 403,
    });
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
