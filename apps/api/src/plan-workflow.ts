import { randomUUID } from 'node:crypto';
import type {
  AgentPlan, ApprovedAgentPlan, ArchitecturePlan, DesignPlan, PlanningRole, PlanReviewer, ProductPlan, TaskDecision,
} from '@ado/shared';
import type { GitHubApp } from './github';

export const planPhases = {
  director: 'PROJECT_DIRECTOR',
  draft: 'PRODUCT_MANAGER',
  architecture: 'ARCHITECT',
  design: 'UI_UX_DESIGNER',
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
  const review = 'review' in step.output ? step.output.review : undefined;
  if (review && (step.role === 'ARCHITECT' || step.role === 'UI_UX_DESIGNER')) {
    const reviewer = step.role;
    for (const question of review.decisions) {
      if (workflow.questions.some((item) => item.question === question.question)) continue;
      workflow.questions.push({ ...question, id: randomUUID(), reviewers: question.reviewers.length ? question.reviewers : [reviewer] });
    }
  }
  if (phase === 'draft' && product?.needsDesign) workflow.queue.push('design');
  if (workflow.queue.length) return null;

  workflow.blockers = planReviewBlockers(steps, Boolean(product?.needsDesign));
  if (workflow.blockers.length) return 'review_evidence_missing';
  if (workflow.questions.some(({ answer }) => !answer)) return 'pending_review_decisions';

  if (phase === 'architecture' || phase === 'design') {
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
