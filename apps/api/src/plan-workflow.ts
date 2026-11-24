import { randomUUID } from 'node:crypto';
import type {
  AgentPlan, ApprovedAgentPlan, ArchitecturePlan, DesignPlan, DirectorPlan, IndependentCheck, PlanningRole, PlanReviewer,
  ProductPlan, TaskDecision, VerificationCheck,
} from '@ado/shared';
import type { GitHubApp } from './github';

export const planPhases = {
  director: 'PROJECT_DIRECTOR',
  draft: 'PRODUCT_MANAGER',
  architecture: 'ARCHITECT',
  design: 'UI_UX_DESIGNER',
  coordinate: 'PROJECT_DIRECTOR',
  revise: 'PRODUCT_MANAGER',
  architecture_review: 'ARCHITECT',
  design_review: 'UI_UX_DESIGNER',
} as const satisfies Record<string, PlanningRole>;

type Phase = keyof typeof planPhases;
type Step = AgentPlan['steps'][number];
export type PlanningSource = Parameters<GitHubApp['planningSource']>[0];

export interface PlanWorkflow {
  queue: Phase[];
  source: PlanningSource;
  evidence?: Awaited<ReturnType<GitHubApp['planningEvidence']>>;
  evidenceHints?: string;
  evidenceGap?: string;
  advisory?: boolean;
  questions: TaskDecision[];
  affected: PlanReviewer[];
  blockers?: string[];
  proposal?: ApprovedAgentPlan;
  approvedVersion?: string;
  approvedTarget?: { repositoryId: string; checks: VerificationCheck[]; independentChecks: IndependentCheck[] };
}

export function isAdvisoryRequest(request: string) {
  const text = request.normalize('NFKC');
  return /(?:给出|提供|输出|制定|提交|出具?|生成)(?:一个|一份|可选的?)?[^。；;，,\n]{0,14}方案|(?:方案|设计)(?:即可|先行)|\b(?:proposal only|plan only|options only|(?:provide|propose|draft|outline) (?:a |the )?(?:plan|proposal|options))\b/iu.test(text)
    && !/(?:并(?:且)?|然后|随后|同时|直接|请|按.{0,12}方案)(?:开始|进行|落地)?(?:实现|开发|部署|上线|修改|执行|修复|实施)(?!方案|建议|思路|对比)|\b(?:and|then|also) (?:implement|deploy|fix|ship|merge)\b/iu.test(text);
}

export function newWorkflow(source: PlanningSource, advisory = false): PlanWorkflow {
  return { queue: ['director', 'draft', 'architecture'], source, advisory, questions: [], affected: [] };
}

export function latestPlanOutput<T extends Step['output']>(steps: Step[], role: PlanningRole) {
  return [...steps].reverse().find((step) => step.role === role && step.phase !== undefined)?.output as T | undefined;
}

export function planReviewBlockers(steps: Step[], needsDesign: boolean) {
  const architecture = latestPlanOutput<ArchitecturePlan>(steps, 'ARCHITECT');
  const design = needsDesign ? latestPlanOutput<DesignPlan>(steps, 'UI_UX_DESIGNER') : undefined;
  return [...new Set([...(architecture?.review?.blockers ?? []), ...(design?.review.blockers ?? [])])];
}

function stageQuestions(step: Step) {
  if ('review' in step.output) return step.output.review?.decisions ?? [];
  return (step.output as DirectorPlan | ProductPlan).decisions ?? [];
}

function decisionKey(question: string) {
  return question.normalize('NFKC').toLowerCase()
    .replace(/(?:此(?:项)?决定尚未作出|this decision (?:has not been made|is still open)).*$/iu, '')
    .replace(/[\p{P}\s]+$/gu, '').trim();
}

function publishReviewedQuestions(workflow: PlanWorkflow, step: Step, candidates: Step[]) {
  const existing = new Map(workflow.questions.map((item) => [decisionKey(item.question), item]));
  const published = new Map([...existing].filter(([, item]) => workflow.advisory || Boolean(item.answer)));
  const coordinated = stageQuestions(step);
  const reviewed = candidates.filter(({ output }) => 'review' in output).flatMap(stageQuestions);
  for (const question of workflow.advisory && !coordinated.length ? reviewed : coordinated) {
    const key = decisionKey(question.question);
    const prior = published.get(key);
    const sourceReviewers = candidates.flatMap(stageQuestions)
      .filter((candidate) => decisionKey(candidate.question) === key).flatMap((candidate) => candidate.reviewers);
    const reviewers = [...new Set([...(prior?.reviewers ?? []), ...sourceReviewers, ...question.reviewers])];
    const roles = reviewers.length ? reviewers : ['ARCHITECT' as const];
    if (prior) {
      prior.reviewers = roles;
      if (!prior.answer) Object.assign(prior, question, { reviewers: roles });
      if (prior.answer && !workflow.advisory) workflow.affected = [...new Set([...workflow.affected, ...roles])];
    } else {
      published.set(key, { ...question, id: existing.get(key)?.id ?? randomUUID(), reviewers: roles });
    }
  }
  workflow.questions = [...published.values()];
}

export function advancePlan(workflow: PlanWorkflow, previous: Step[], step: Step) {
  const phase = workflow.queue.shift();
  const steps = [...previous, step];
  const product = latestPlanOutput<ProductPlan>(steps, 'PRODUCT_MANAGER');
  const architecture = latestPlanOutput<ArchitecturePlan>(steps, 'ARCHITECT');
  const design = latestPlanOutput<DesignPlan>(steps, 'UI_UX_DESIGNER');
  if (phase === 'draft' && product?.needsDesign) workflow.queue.push('design');
  if (workflow.queue.length) return null;

  workflow.blockers = [...new Set([
    ...(workflow.evidenceGap ? [workflow.evidenceGap] : []),
    ...planReviewBlockers(steps, Boolean(product?.needsDesign)),
  ])];
  const candidates = previous.slice(previous.map(({ phase }) => phase).lastIndexOf('coordinate') + 1);
  if (phase === 'coordinate') publishReviewedQuestions(workflow, step, candidates);
  const reviewFinished = phase === 'architecture' || phase === 'design'
    || phase === 'architecture_review' || phase === 'design_review';
  if (workflow.advisory) {
    if (reviewFinished && !steps.some(({ phase }) => phase === 'coordinate')) {
      workflow.queue.push('coordinate');
      return null;
    }
    if (phase === 'revise') {
      if (workflow.affected.includes('ARCHITECT')) workflow.queue.push('architecture_review');
      if (workflow.affected.includes('UI_UX_DESIGNER') && design) workflow.queue.push('design_review');
    }
    if (phase === 'architecture_review' || phase === 'design_review') publishReviewedQuestions(workflow, step, [step]);
    if (workflow.queue.length) return null;
    workflow.affected = [];
    return 'advisory_ready';
  }
  if (reviewFinished && [...candidates, step].some((stage) => stageQuestions(stage).length > 0)) {
    workflow.queue.push('coordinate');
    return null;
  }
  if (workflow.questions.some(({ answer }) => !answer)) return 'pending_review_decisions';
  if (workflow.blockers.length) return 'review_evidence_missing';

  if (!steps.some(({ phase }) => phase === 'revise')) {
    workflow.queue.push('revise');
    return null;
  }
  if (phase === 'revise' && product) {
    const original = latestPlanOutput<ProductPlan>(previous, 'PRODUCT_MANAGER');
    const reviewers = new Set(workflow.affected.length ? workflow.affected : [...(product.affectedReviewers ?? []),
      ...(product.decisions ?? []).flatMap((decision) => decision.reviewers.length ? decision.reviewers : ['ARCHITECT' as const])]);
    if (!workflow.affected.length && original && ['title', 'userStory', 'requirements', 'acceptanceCriteria'].some((key) =>
      JSON.stringify(original[key as keyof ProductPlan]) !== JSON.stringify(product[key as keyof ProductPlan]))) {
      reviewers.add('ARCHITECT');
    }
    if (product.needsDesign && !design) reviewers.add('UI_UX_DESIGNER');
    if (reviewers.has('ARCHITECT')) workflow.queue.push('architecture_review');
    if (product.needsDesign && reviewers.has('UI_UX_DESIGNER')) workflow.queue.push('design_review');
    workflow.affected = [];
    if (workflow.queue.length) return null;
  }
  if (!product || !architecture || !workflow.evidence || (product.needsDesign && !design)) {
    throw new Error('Required planning outputs are missing');
  }
  workflow.proposal = {
    version: randomUUID(), repository: workflow.source.repository, branch: workflow.source.branch,
    commit: workflow.evidence.commit, product, architecture, ...(product.needsDesign && design && { design }),
  };
  return null;
}
