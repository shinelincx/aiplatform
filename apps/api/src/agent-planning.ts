import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Injectable, Logger, NotFoundException,
  type OnApplicationBootstrap, type OnModuleDestroy, Param, ParseUUIDPipe, Post, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { developerRoles, isPlanningFailureCategory, isWorkerId, maxPlanKnowledgeVersions, planningRoles, type Account,
  type AgentAssignment, type AgentPlan, type AgentRole, type ArchitecturePlan, type KnowledgeSnapshot, type ModelUsage,
  type PlanningFailureCategory, type ProductPlan, type ProjectRequirement } from '@ado/shared';
import type { PoolClient } from 'pg';
import { AgentRegistryService } from './agent-registry';
import { CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { GitHubApp } from './github';
import { advancePlan, latestPlanOutput, newWorkflow, planPhases, type PlanWorkflow } from './plan-workflow';
import { objectInput, textInput } from './input';
import { PLANNING_MODEL, PlanningFailure, validatePlanningOutput, type PlanningModel } from './planning-model';
import { selectKnowledgeVersions } from './project-knowledge';
import { ProjectsService } from './projects';
import { TasksService } from './tasks';

const planFields = `task_id AS "taskId", project_id AS "projectId", state, input, assignments, steps, error, failure_category AS "failureCategory",
  lease_id AS "leaseId"`;

interface PlanRecord {
  taskId: string;
  projectId: string;
  state: AgentPlan['state'];
  input: { request: string; project: string; repository: string; baseBranch: string;
    requirement?: ProjectRequirement; knowledge?: KnowledgeSnapshot[]; workflow?: PlanWorkflow };
  assignments: Partial<Record<AgentRole, AgentAssignment>>;
  steps: AgentPlan['steps'];
  error: string | null;
  failureCategory: string | null;
  leaseId: string | null;
}

function currentRole(row: PlanRecord) {
  return row.input.workflow ? planPhases[row.input.workflow.queue[0]] : planningRoles[row.steps.length];
}

function publicPlan(row: PlanRecord, showDiagnosis = false): AgentPlan {
  return {
    taskId: row.taskId, state: row.state, stage: currentRole(row) ?? null, steps: row.steps, error: row.error,
    ...(row.input.workflow && {
      reviewStatus: row.input.workflow.proposal ? 'ready'
        : row.error === 'review_evidence_missing' || row.error === 'design_role_missing' ? 'waiting_evidence'
        : row.input.workflow.questions.some(({ answer }) => !answer) ? 'waiting_decisions'
        : row.steps.some(({ phase }) => phase === 'revise') || row.input.workflow.queue[0] === 'revise' ? 'revising' : 'reviewing',
      blockers: row.input.workflow.blockers,
      proposal: row.input.workflow.proposal,
      approvedVersion: row.input.workflow.approvedVersion,
    }),
    ...(showDiagnosis && row.state === 'failed' && isPlanningFailureCategory(row.failureCategory)
      && { failureCategory: row.failureCategory }),
    ...(row.input.requirement && { requirement: row.input.requirement }),
    ...(row.input.knowledge && { knowledge: row.input.knowledge }),
  };
}

@Injectable()
export class AgentPlanningService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentPlanningService.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(AgentRegistryService) private readonly registry: AgentRegistryService,
    @Inject(PLANNING_MODEL) private readonly model: PlanningModel,
    @Inject(GitHubApp) private readonly github: GitHubApp,
  ) {}

  onApplicationBootstrap() {
    if (!this.model.available()) return;
    this.timer = setInterval(() => {
      if (!this.busy) void this.runNext().catch(() => {
        this.logger.error('Planning queue could not be processed');
      });
    }, 1500).unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async start(actor: Account, projectId: string, body: unknown) {
    const input = objectInput(body);
    const repositoryId = textInput(input.repositoryId, 'repository ID', 36);
    const request = textInput(input.request, 'request', 8000);
    const requirementId = input.requirementId ?? null;
    if (requirementId !== null && !isWorkerId(requirementId)) throw new BadRequestException('Invalid requirement ID');
    const knowledgeIds = input.knowledgeVersionIds === undefined ? [] : input.knowledgeVersionIds;
    if (!Array.isArray(knowledgeIds) || knowledgeIds.length > maxPlanKnowledgeVersions || !knowledgeIds.every(isWorkerId)) {
      throw new BadRequestException('Invalid knowledge version selection');
    }
    if (new Set(knowledgeIds).size !== knowledgeIds.length) throw new BadRequestException('Duplicate knowledge version ID');
    return this.db.transaction(async (client) => {
      const project = await this.projects.access(actor.id, projectId, { write: true, active: true }, client);
      if (!isWorkerId(repositoryId)) throw new NotFoundException('Repository not found');
      const { rows: [repository] } = await client.query<{ fullName: string; baseBranch: string; installationId: string; githubId: string }>(
        `SELECT owner || '/' || repo_name AS "fullName", default_branch AS "baseBranch",
           installation_id::text AS "installationId", github_repository_id::text AS "githubId"
         FROM repositories WHERE project_id = $1 AND id = $2`, [projectId, repositoryId]);
      if (!repository) throw new NotFoundException('Repository not found');
      const requirement = requirementId ? await this.projects.requirement(client, projectId, requirementId) : undefined;
      const knowledge = knowledgeIds.length ? await selectKnowledgeVersions(client, projectId, knowledgeIds) : undefined;
      if (!this.model.available()) throw new ServiceUnavailableException('Planning provider is unconfigured');
      const registry = await this.registry.view(projectId, client);
      const assignments: PlanRecord['assignments'] = {};
      for (const role of planningRoles) {
        const assignment = this.registry.snapshot(registry, role, this.model.defaultModel());
        if (!assignment) throw new ConflictException('A required planning role is disabled');
        if (!assignment.model) throw new ServiceUnavailableException('Planning model is unconfigured');
        assignments[role] = assignment;
      }
      const designer = this.registry.snapshot(registry, 'UI_UX_DESIGNER', this.model.defaultModel());
      if (designer?.model) assignments.UI_UX_DESIGNER = designer;
      for (const role of developerRoles) {
        const assignment = this.registry.snapshot(registry, role, '');
        if (assignment) assignments[role] = assignment;
      }
      if (!developerRoles.some((role) => assignments[role])) throw new ConflictException('No developer role is enabled');
      const qa = this.registry.snapshot(registry, 'QA_ENGINEER', this.model.defaultModel());
      if (!qa) throw new ConflictException('The QA role is disabled');
      if (!qa.model) throw new ServiceUnavailableException('QA model is unconfigured');
      assignments.QA_ENGINEER = qa;

      const taskId = randomUUID();
      const title = [...request.split(/\r?\n/, 1)[0]].slice(0, 120).join('');
      await client.query(
        `INSERT INTO tasks (id, project_id, repository_id, task_code, title, description,
          priority, status, acceptance_criteria, created_by) VALUES ($1,$2,$3,$4,$5,$6,'P1','PLANNING','[]',$7)`,
        [taskId, projectId, repositoryId, `AI-${taskId.toUpperCase()}`, title, request, actor.id]);
      const task = await this.tasks.find(projectId, taskId, client);
      const { rows: [row] } = await client.query<PlanRecord>(
        `INSERT INTO task_agent_plans (project_id, task_id, state, input, assignments)
         VALUES ($1,$2,'queued',$3,$4) RETURNING ${planFields}`,
        [projectId, taskId, {
          request, project: project.name, repository: repository.fullName, baseBranch: repository.baseBranch, requirement, knowledge,
          workflow: newWorkflow({ repository: repository.fullName, branch: repository.baseBranch,
            installationId: Number(repository.installationId), githubId: Number(repository.githubId) }),
        }, assignments]);
      await this.tasks.event(client, task, 'task.created', { actorId: actor.id, status: task.status });
      await this.tasks.event(client, task, 'agent.plan_queued', {
        actorId: actor.id, ...(requirement && { requirementId: requirement.id }), ...(knowledge && { knowledgeVersionIds: knowledgeIds }),
      });
      return publicPlan(row);
    });
  }

  async get(actor: Account, projectId: string, taskId: string) {
    const project = await this.projects.access(actor.id, projectId);
    await this.tasks.find(projectId, taskId);
    const { rows: [row] } = await this.db.projectQuery<PlanRecord>(projectId,
      `SELECT ${planFields} FROM task_agent_plans WHERE project_id = $1 AND task_id = $2`, [projectId, taskId]);
    return { plan: row ? publicPlan(row, project.role === 'owner') : null };
  }

  async retry(actor: Account, projectId: string, taskId: string) {
    return this.db.transaction(async (client) => {
      const project = await this.projects.access(actor.id, projectId, { write: true, active: true }, client);
      const task = await this.tasks.find(projectId, taskId, client);
      const { rows: [row] } = await client.query<PlanRecord>(
        `SELECT ${planFields} FROM task_agent_plans WHERE project_id = $1 AND task_id = $2 FOR UPDATE`,
        [projectId, taskId]);
      const workflow = row?.input.workflow;
      const refresh = Boolean(workflow?.proposal && project.role === 'owner' && ['WAITING_APPROVAL', 'READY', 'FAILED', 'REJECTED', 'TIMEOUT'].includes(task.status));
      if (!row || task.archivedAt || (!refresh && (task.status !== 'PLANNING' || row.state !== 'failed'
        || row.error === 'pending_review_decisions'))) throw new ConflictException('There is no plan to retry');
      if (!this.model.available()) throw new ServiceUnavailableException('Planning provider is unconfigured');

      if (workflow && (refresh || row.error === 'review_evidence_missing')) {
        const { rows: [binding] } = await client.query<{ branch: string }>(
          'SELECT default_branch AS branch FROM repositories WHERE project_id = $1 AND id = $2', [projectId, task.repositoryId]);
        if (!binding) throw new ConflictException('Project repository is no longer available');
        row.input.baseBranch = binding.branch;
        row.input.workflow = {
          ...newWorkflow({ ...workflow.source, branch: binding.branch }),
          questions: task.decisions ?? workflow.questions,
          evidenceHints: workflow.blockers?.join(' '),
        };
        row.steps = [];
        if (refresh) {
          await client.query("UPDATE tasks SET status = 'PLANNING', approved_developer = NULL, updated_at = now() WHERE id = $1", [taskId]);
          await this.tasks.event(client, task, 'task.status_changed', { actorId: actor.id, from: task.status, to: 'PLANNING' });
        }
      }
      if (row.error === 'design_role_missing') {
        const registry = await this.registry.view(projectId, client);
        const designer = this.registry.snapshot(registry, 'UI_UX_DESIGNER', this.model.defaultModel());
        if (!designer?.model) throw new ConflictException('Enable the UI/UX Agent before retrying');
        row.assignments.UI_UX_DESIGNER = designer;
        if (workflow) workflow.blockers = [];
      }
      await client.query('UPDATE task_agent_plans SET assignments = $2 WHERE task_id = $1', [taskId, row.assignments]);
      await this.saveProgress(client, row, 'queued', row.steps, null);
      await this.tasks.event(client, task, 'agent.plan_retried', { actorId: actor.id, stage: currentRole(row) });
      return publicPlan({ ...row, state: 'queued', error: null });
    });
  }

  async runNext() {
    if (this.busy) return false;
    this.busy = true;
    try {
      const row = await this.db.transaction(async (client) => {
        const taskId = await this.db.nextProjectJob(client, 'planning_candidate');
        if (!taskId) return null;
        const { rows: [claimed] } = await client.query<PlanRecord>(
          `UPDATE task_agent_plans SET state = 'running', lease_id = gen_random_uuid(),
             lease_expires_at = now() + interval '3 minutes', updated_at = now()
           WHERE task_id = $1 RETURNING ${planFields}`, [taskId]);
        return claimed;
      });
      if (!row) return false;

      const workflow = row.input.workflow;
      const phase = workflow?.queue[0];
      const role = currentRole(row);
      const agent = row.assignments[role];
      const developers = developerRoles.filter((item) => row.assignments[item]);
      let step: AgentPlan['steps'][number];
      let usage: ModelUsage | undefined;
      try {
        if (workflow && role === 'UI_UX_DESIGNER' && !agent) {
          workflow.blockers = ['此任务需要 UI/UX 评审。请启用并配置 UI/UX Agent 后重试。'];
          await this.settle(row, null, undefined, undefined, 'design_role_missing');
          return true;
        }
        if (!agent) throw new Error('Planning role is missing');
        if (workflow && role === 'ARCHITECT' && !workflow.evidence) {
          workflow.evidence = await this.github.planningEvidence(workflow.source,
            [row.input.request, workflow.evidenceHints].filter(Boolean).join('\n')).catch(() => undefined);
          if (!workflow.evidence?.files.length) {
            workflow.blockers = ['无法读取此项目仓库的评审证据。请检查仓库绑定和 GitHub App 的读取权限后重试。'];
            await this.settle(row, null, undefined, undefined, 'review_evidence_missing');
            return true;
          }
        }
        const { requirement, knowledge, request, project, repository, baseBranch } = row.input;
        const response = await this.model.generate(role, agent, {
          request, project, repository, baseBranch, priorSteps: row.steps, availableDevelopers: developers,
          ...(workflow && {
            phase, repositoryEvidence: workflow.evidence,
            currentProductDraft: latestPlanOutput<ProductPlan>(row.steps, 'PRODUCT_MANAGER'),
            humanDecisions: workflow.questions,
          }),
          ...(requirement && { approvedRequirement: { title: requirement.title, excerpt: requirement.excerpt } }),
          ...(knowledge && { approvedKnowledge: knowledge }),
        });
        usage = response.usage;
        const output = validatePlanningOutput(role, response.output);
        if ('developer' in output && !developers.includes(output.developer)) {
          throw new PlanningFailure('invalid_structured_output');
        }
        if (workflow && (role === 'ARCHITECT' || role === 'UI_UX_DESIGNER')) {
          const review = 'review' in output ? output.review : undefined;
          if ((role === 'ARCHITECT' && (output as ArchitecturePlan).decisions?.length) || !review || review.evidence.some((path) => !workflow.evidence?.files.some((file) => file.path === path))
            || (!review.evidence.length && !review.blockers.length)) throw new PlanningFailure('invalid_structured_output');
        }
        if (workflow && role === 'PRODUCT_MANAGER') {
          const product = output as ProductPlan;
          if (product.needsDesign === undefined) throw new PlanningFailure('invalid_structured_output');
          if (phase === 'revise' && latestPlanOutput<ProductPlan>(row.steps, 'PRODUCT_MANAGER')?.needsDesign) product.needsDesign = true;
        }
        step = { role, version: agent.version, model: agent.model, output, ...(phase && { phase }) };
      } catch (error) {
        const failure = error instanceof PlanningFailure ? error : undefined;
        await this.settle(row, null, usage ?? failure?.usage, failure?.category ?? 'unknown');
        return true;
      }
      await this.settle(row, step, usage);
      return true;
    } finally {
      this.busy = false;
    }
  }

  private async settle(row: PlanRecord, step: AgentPlan['steps'][number] | null, usage?: ModelUsage,
    category?: PlanningFailureCategory, reason = 'planning_step_failed') {
    await this.db.projectTransaction(row.projectId, async (client) => {
      const { rows: [project] } = await client.query<{ status: string }>(
        'SELECT status FROM projects WHERE id = $1 FOR UPDATE', [row.projectId]);
      const current = await client.query<{ input: PlanRecord['input'] }>(
        "SELECT input FROM task_agent_plans WHERE task_id = $1 AND lease_id = $2 AND state = 'running' FOR UPDATE",
        [row.taskId, row.leaseId]);
      if (!current.rowCount && !usage) return;
      const task = await this.tasks.find(row.projectId, row.taskId, client);
      if (usage && row.leaseId) {
        await this.tasks.recordModelUsage(client, task, row.leaseId, { role: currentRole(row), usage });
      }
      if (!current.rowCount) return;
      if (task.status !== 'PLANNING' || task.archivedAt || project?.status !== 'active') {
        await this.saveProgress(client, row, 'cancelled', row.steps, null);
        await this.tasks.event(client, task, 'agent.plan_cancelled', {});
        return;
      }
      if (!step) {
        if (row.input.workflow && current.rows[0].input.workflow) {
          row.input.workflow.questions = current.rows[0].input.workflow.questions;
          row.input.workflow.affected = current.rows[0].input.workflow.affected;
        }
        await this.saveProgress(client, row, 'failed', row.steps, reason, category);
        await this.tasks.event(client, task, 'agent.plan_failed', { role: currentRole(row), error: reason });
        return;
      }

      const steps = [...row.steps, step];
      await this.tasks.event(client, task, 'agent.step_completed', { role: step.role, version: step.version, model: step.model, phase: step.phase });
      const workflow = row.input.workflow;
      if (workflow && current.rows[0].input.workflow) {
        workflow.questions = current.rows[0].input.workflow.questions;
        workflow.affected = current.rows[0].input.workflow.affected;
        const pause = advancePlan(workflow, row.steps, step);
        if (!workflow.proposal) {
          await this.saveProgress(client, row, pause ? 'failed' : 'queued', steps, pause);
          return;
        }
        await this.tasks.event(client, task, 'agent.plan_version_ready', {
          proposal: workflow.proposal, version: workflow.proposal.version, commit: workflow.proposal.commit,
        });
      }
      if (!workflow && step.role !== 'ARCHITECT') {
        await this.saveProgress(client, row, 'queued', steps, null);
        return;
      }
      const product = workflow?.proposal?.product ?? steps[1].output as ProductPlan;
      const architecture = workflow?.proposal?.architecture ?? step.output as ArchitecturePlan;
      const description = [product.userStory, ...product.requirements.map((item) => `- ${item}`)].join('\n');
      await client.query(
        `UPDATE tasks SET title = $3, description = $4, acceptance_criteria = $5,
         status = 'WAITING_APPROVAL', updated_at = now() WHERE project_id = $1 AND id = $2`,
        [row.projectId, row.taskId, product.title, description, JSON.stringify(product.acceptanceCriteria)]);
      await this.saveProgress(client, row, 'completed', steps, null);
      await this.tasks.event(client, task, 'task.status_changed', {
        from: task.status, to: 'WAITING_APPROVAL', developer: architecture.developer,
      });
    });
  }

  private async saveProgress(client: PoolClient, row: PlanRecord, state: AgentPlan['state'],
    steps: AgentPlan['steps'], error: string | null, category: PlanningFailureCategory | null = null) {
    await client.query(
      `UPDATE task_agent_plans SET state = $2, steps = $3, error = $4, failure_category = $5,
       lease_id = NULL, lease_expires_at = NULL, updated_at = now(), input = $6 WHERE task_id = $1`,
      [row.taskId, state, JSON.stringify(steps), error, category, row.input]);
  }
}

@Controller('projects/:projectId')
@UseGuards(SessionGuard)
export class AgentPlanningController {
  constructor(@Inject(AgentPlanningService) private readonly planning: AgentPlanningService) {}

  @Post('agent-plans')
  start(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() body: unknown) {
    return this.planning.start(actor, projectId, body);
  }

  @Get('tasks/:taskId/agent-plan')
  get(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.planning.get(actor, projectId, taskId);
  }

  @Post('tasks/:taskId/agent-plan/retry')
  @HttpCode(200)
  retry(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.planning.retry(actor, projectId, taskId);
  }
}
