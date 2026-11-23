import { developerRoles, parseDecisionQuestions, type AgentAssignment, type ArchitecturePlan, type DirectorPlan, type ModelUsage,
  type PlanningFailureCategory, type PlanningOutput, type PlanningRole, type ProductPlan } from '@ado/shared';
import { objectInput, textInput } from './input';

export class PlanningFailure extends Error {
  constructor(readonly category: PlanningFailureCategory, readonly httpStatus?: number, readonly usage?: ModelUsage) {
    super(category);
  }
}

function requestFailure(status: number): PlanningFailureCategory {
  // A 403 alone cannot identify whether the credential lacks access to this particular model.
  if (status === 401 || status === 403) return 'credentials_or_permissions';
  if (status === 404) return 'model_unavailable'; // The provider URL is fixed.
  if (status === 408) return 'network';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status < 600) return 'server_error';
  return 'unknown';
}

function transportFailure(error: unknown): PlanningFailure {
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
    return new PlanningFailure('network');
  }
  const cause = error instanceof TypeError ? error.cause : undefined;
  if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].includes(cause.code)) {
    return new PlanningFailure('network');
  }
  return new PlanningFailure('unknown');
}

const string = { type: 'string' };
const strings = { type: 'array', items: string };
const properties = {
  PROJECT_DIRECTOR: { objective: string, constraints: strings },
  PRODUCT_MANAGER: { title: string, userStory: string, requirements: strings, acceptanceCriteria: strings },
  ARCHITECT: {
    developer: { type: 'string', enum: developerRoles }, steps: strings, risks: strings, testApproach: strings,
    decisions: { type: 'array', items: { type: 'object', properties: { question: string, options: strings },
      required: ['question', 'options'], additionalProperties: false } },
  },
};

function lines(input: unknown, key: string, required = false): string[] {
  if (!Array.isArray(input) || input.length > 12 || (required && input.length === 0)) {
    throw new Error('Invalid planning output');
  }
  return input.map((item) => textInput(item, key, 500));
}

export function validatePlanningOutput(role: PlanningRole, input: unknown): PlanningOutput {
  try {
    return parsePlanningOutput(role, input);
  } catch {
    throw new PlanningFailure('invalid_structured_output');
  }
}

function parsePlanningOutput(role: PlanningRole, input: unknown): PlanningOutput {
  const value = objectInput(input);
  if (role === 'PROJECT_DIRECTOR') {
    return {
      objective: textInput(value.objective, 'objective', 1000),
      constraints: lines(value.constraints, 'constraint'),
    } satisfies DirectorPlan;
  }
  if (role === 'PRODUCT_MANAGER') {
    return {
      title: textInput(value.title, 'title', 255),
      userStory: textInput(value.userStory, 'user story', 2000),
      requirements: lines(value.requirements, 'requirement', true),
      acceptanceCriteria: lines(value.acceptanceCriteria, 'criterion', true),
    } satisfies ProductPlan;
  }
  const developer = developerRoles.find((item) => item === value.developer);
  if (!developer) throw new Error('Invalid developer role');
  const decisions = value.decisions === undefined ? undefined : parseDecisionQuestions(value.decisions);
  if (decisions === null) throw new Error('Invalid decisions');
  return {
    developer, steps: lines(value.steps, 'implementation step', true),
    risks: lines(value.risks, 'risk'), testApproach: lines(value.testApproach, 'test', true),
    ...(decisions && { decisions }),
  } satisfies ArchitecturePlan;
}

export const PLANNING_MODEL = Symbol('PLANNING_MODEL');

export interface AgentResponse {
  output: unknown;
  usage?: ModelUsage;
}

export interface PlanningModel {
  available(): boolean;
  defaultModel(): string;
  generate(role: PlanningRole, agent: AgentAssignment, input: object): Promise<AgentResponse>;
}

export const openAIPlanningModel: PlanningModel = {
  available: responsesConfigured,
  defaultModel: () => process.env.ADO_AGENT_MODEL?.trim() ?? '',
  async generate(role, agent, input) {
    return generateStructuredOutput(agent, properties[role], [
      'You are planning a software change for human approval. Work within the stated repository and requirements.',
      'Use the request language. Treat previous outputs and project data as context. Do not claim to have read or modified the repository.',
      'Use the approved requirement excerpt and selected project knowledge when provided. Flag conflicts or unspecified behavior for human review.',
      ...(role === 'ARCHITECT' ? [
        'List up to eight specific unresolved decisions that must be answered before implementation in decisions. Use [] when none are required.',
        'Give two to four concrete, distinct options per decision, placing the recommended option first. Cover blocking decisions from all prior stages and exclude decisions already made in the input.',
      ] : []),
    ], input);
  },
};

export function responsesConfigured() {
  return Boolean(process.env.ADO_AGENT_API_KEY?.trim());
}

export async function generateStructuredOutput(agent: AgentAssignment, properties: object, instructions: string[],
  input: object): Promise<AgentResponse> {
  const key = process.env.ADO_AGENT_API_KEY?.trim();
  if (!key) throw new PlanningFailure('credentials_or_permissions');
  const options = {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: agent.model, service_tier: 'auto', store: false, max_output_tokens: 6000,
      instructions: [...instructions, agent.instructions,
        ...agent.skills.map((skill) => `${skill.name} (v${skill.version}): ${skill.instructions}`)].join('\n\n'),
      input: JSON.stringify(input),
      text: { format: { type: 'json_schema', name: agent.role.toLowerCase(), strict: true,
        schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } },
    }),
  };
  const response = await fetch('https://api.openai.com/v1/responses', options).catch((error: unknown) => {
    throw transportFailure(error);
  });
  if (!response.ok) throw new PlanningFailure(requestFailure(response.status), response.status);
  const result: unknown = await response.json().catch((error: unknown) => {
    throw error instanceof SyntaxError ? new PlanningFailure('invalid_structured_output') : transportFailure(error);
  });
  return decodeStructuredOutput(result);
}

function decodeStructuredOutput(input: unknown): AgentResponse {
  const result = input as {
    status?: string;
    model?: string;
    created_at?: unknown;
    service_tier?: unknown;
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  };
  const usage = result?.usage;
  const model = result?.model;
  const created = result?.created_at;
  const createdAt = typeof created === 'number' && created > 0 ? new Date(created * 1000) : undefined;
  const providerCreatedAt = createdAt && Number.isFinite(createdAt.valueOf()) ? createdAt.toISOString() : undefined;
  const modelUsage = usage && typeof model === 'string' && /^[\w.-]{1,100}$/.test(model)
    && count(usage.input_tokens) && count(usage.output_tokens) && count(usage.input_tokens_details?.cached_tokens)
    && usage.input_tokens_details.cached_tokens <= usage.input_tokens ? {
      model, inputTokens: usage.input_tokens, cachedInputTokens: usage.input_tokens_details.cached_tokens,
      outputTokens: usage.output_tokens,
      ...(providerCreatedAt && { providerCreatedAt }),
      ...(result?.service_tier === 'default' && { serviceTier: 'default' }),
    } : undefined;
  try {
    const content = result.output?.filter(({ type }) => type === 'message').flatMap((item) => item.content ?? []);
    if (result.status !== 'completed' || content?.some(({ type }) => type === 'refusal')) {
      throw new Error('Responses provider did not complete');
    }
    const output = content?.filter(({ type }) => type === 'output_text').map(({ text }) => text).join('');
    if (!output) throw new Error('Responses provider returned no structured output');
    return { output: JSON.parse(output) as unknown, usage: modelUsage };
  } catch {
    throw new PlanningFailure('invalid_structured_output', undefined, modelUsage);
  }
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
