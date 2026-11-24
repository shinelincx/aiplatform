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
  questions: TaskDecision[];
  affected: PlanReviewer[];
  blockers?: string[];
  proposal?: ApprovedAgentPlan;
  approvedVersion?: string;
  approvedTarget?: { repositoryId: string; checks: VerificationCheck[]; independentChecks: IndependentCheck[] };
}

export function newWorkflow(source: PlanningSource): PlanWorkflow {
  return { queue: ['director', 'draft', 'architecture'], source, questions: [], affected: [] };
}

export function latestPlanOutput<T extends Step['output']>(steps: Step[], role: PlanningRole) {
  return [...steps].reverse().find((step) => step.role === role && step.phase !== undefined)?.output as T | undefined;
}

export function planReviewBlockers(steps: Step[], needsDesign: boolean) {
  const architecture = latestPlanOutput<ArchitecturePlan>(steps, 'ARCHITECT');
  const design = needsDesign ? latestPlanOutput<DesignPlan>(steps, 'UI_UX_DESIGNER') : undefined;
  return [...new Set([...(architecture?.review?.blockers ?? []), ...(design?.review.blockers ?? [])])];
}

export function advancePlan(workflow: PlanWorkflow, previous: Step[], step: Step) {
  const phase = workflow.queue.shift();
  const steps = [...previous, step];
  const product = latestPlanOutput<ProductPlan>(steps, 'PRODUCT_MANAGER');
  const architecture = latestPlanOutput<ArchitecturePlan>(steps, 'ARCHITECT');
  const design = latestPlanOutput<DesignPlan>(steps, 'UI_UX_DESIGNER');
  const isReviewer = step.role === 'ARCHITECT' || step.role === 'UI_UX_DESIGNER';
  const questions = isReviewer && 'review' in step.output ? step.output.review?.decisions
    : (step.output as DirectorPlan | ProductPlan).decisions;
  for (const question of questions ?? []) {
    const roles = question.reviewers.length ? question.reviewers : [isReviewer ? step.role : 'ARCHITECT'] as PlanReviewer[];
    const existing = workflow.questions.find((item) => item.question === question.question);
    if (existing) {
      existing.reviewers = [...new Set([...(existing.reviewers ?? []), ...roles])];
      if (existing.answer) workflow.affected = [...new Set([...workflow.affected, ...roles])];
    } else {
      workflow.questions.push({ ...question, id: randomUUID(), reviewers: roles });
    }
  }
  if (phase === 'draft' && product?.needsDesign) workflow.queue.push('design');
  if (workflow.queue.length) return null;

  workflow.blockers = planReviewBlockers(steps, Boolean(product?.needsDesign));
  const initialReview = phase === 'architecture' || phase === 'design';
  if (initialReview && (workflow.blockers.length || workflow.questions.length)) {
    workflow.queue.push('coordinate');
    return null;
  }
  if (workflow.blockers.length) return 'review_evidence_missing';
  if (workflow.questions.some(({ answer }) => !answer)) return 'pending_review_decisions';

  if (initialReview || phase === 'coordinate') {
    workflow.queue.push('revise');
    return null;
  }
  if (phase === 'revise' && product) {
    const original = latestPlanOutput<ProductPlan>(previous, 'PRODUCT_MANAGER');
    const reviewers = new Set([...workflow.affected, ...(product.affectedReviewers ?? [])]);
    if (original && ['title', 'userStory', 'requirements', 'acceptanceCriteria'].some((key) =>
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
