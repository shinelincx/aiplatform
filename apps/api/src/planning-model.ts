import { developerRoles, type AgentAssignment, type ArchitecturePlan, type DirectorPlan, type ModelUsage,
  type PlanningOutput, type PlanningRole, type ProductPlan } from '@ado/shared';
import { objectInput, textInput } from './input';

const string = { type: 'string' };
const strings = { type: 'array', items: string };
const properties = {
  PROJECT_DIRECTOR: { objective: string, constraints: strings },
  PRODUCT_MANAGER: { title: string, userStory: string, requirements: strings, acceptanceCriteria: strings },
  ARCHITECT: { developer: { type: 'string', enum: developerRoles }, steps: strings, risks: strings, testApproach: strings },
};

function lines(input: unknown, key: string, required = false): string[] {
  if (!Array.isArray(input) || input.length > 12 || (required && input.length === 0)) {
    throw new Error('Invalid planning output');
  }
  return input.map((item) => textInput(item, key, 500));
}

export function validatePlanningOutput(role: PlanningRole, input: unknown): PlanningOutput {
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
  return {
    developer, steps: lines(value.steps, 'implementation step', true),
    risks: lines(value.risks, 'risk'), testApproach: lines(value.testApproach, 'test', true),
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
      'Use the approved requirement excerpt when provided. Flag conflicting or unspecified behavior for human review.',
    ], input);
  },
};

export function responsesConfigured() {
  return Boolean(process.env.ADO_AGENT_API_KEY?.trim());
}

export async function generateStructuredOutput(agent: AgentAssignment, properties: object, instructions: string[],
  input: object): Promise<AgentResponse> {
  const key = process.env.ADO_AGENT_API_KEY?.trim();
  if (!key) throw new Error('Responses provider is unconfigured');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: agent.model, store: false, max_output_tokens: 6000,
      instructions: [...instructions, agent.instructions,
        ...agent.skills.map((skill) => `${skill.name} (v${skill.version}): ${skill.instructions}`)].join('\n\n'),
      input: JSON.stringify(input),
      text: { format: { type: 'json_schema', name: agent.role.toLowerCase(), strict: true,
        schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } },
    }),
  });
  if (!response.ok) throw new Error('Responses provider request failed');
  const result = await response.json() as {
    status?: string;
    model?: string;
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  };
  const content = result.output?.filter(({ type }) => type === 'message').flatMap((item) => item.content ?? []);
  if (result.status !== 'completed' || content?.some(({ type }) => type === 'refusal')) {
    throw new Error('Responses provider did not complete');
  }
  const output = content?.filter(({ type }) => type === 'output_text').map(({ text }) => text).join('');
  if (!output) throw new Error('Responses provider returned no structured output');
  const usage = result.usage;
  const model = result.model;
  const modelUsage = usage && typeof model === 'string' && /^[\w.-]{1,100}$/.test(model)
    && count(usage.input_tokens) && count(usage.output_tokens) && count(usage.input_tokens_details?.cached_tokens)
    && usage.input_tokens_details.cached_tokens <= usage.input_tokens ? {
      model, inputTokens: usage.input_tokens, cachedInputTokens: usage.input_tokens_details.cached_tokens,
      outputTokens: usage.output_tokens,
    } : undefined;
  return { output: JSON.parse(output) as unknown, usage: modelUsage };
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
