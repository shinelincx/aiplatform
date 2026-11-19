import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Injectable, Logger, NotFoundException,
  type OnApplicationBootstrap, type OnModuleDestroy, Param, ParseUUIDPipe, Post, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { developerRoles, isPlanningFailureCategory, isWorkerId, planningRoles, type Account, type AgentAssignment, type AgentPlan, type AgentRole,
  type ArchitecturePlan, type ModelUsage, type PlanningFailureCategory, type ProductPlan, type ProjectRequirement } from '@ado/shared';
import type { PoolClient } from 'pg';
import { AgentRegistryService } from './agent-registry';
import { CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { objectInput, textInput } from './input';
import { PLANNING_MODEL, PlanningFailure, validatePlanningOutput, type PlanningModel } from './planning-model';
import { ProjectsService } from './projects';
import { TasksService } from './tasks';

const planFields = `task_id AS "taskId", project_id AS "projectId", state, input, assignments, steps, error, failure_category AS "failureCategory",
  lease_id AS "leaseId"`;

interface PlanRecord {
  taskId: string;
  projectId: string;
  state: AgentPlan['state'];
  input: { request: string; project: string; repository: string; baseBranch: string; requirement?: ProjectRequirement };
  assignments: Partial<Record<AgentRole, AgentAssignment>>;
  steps: AgentPlan['steps'];
  error: string | null;
  failureCategory: string | null;
  leaseId: string | null;
}

function publicPlan(row: PlanRecord, showDiagnosis = false): AgentPlan {
  return {
    taskId: row.taskId, state: row.state, stage: planningRoles[row.steps.length] ?? null, steps: row.steps, error: row.error,
    ...(showDiagnosis && row.state === 'failed' && isPlanningFailureCategory(row.failureCategory)
      && { failureCategory: row.failureCategory }),
    ...(row.input.requirement && { requirement: row.input.requirement }),
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
    return this.db.transaction(async (client) => {
      const project = await this.projects.access(actor.id, projectId, { write: true, active: true }, client);
      if (!isWorkerId(repositoryId)) throw new NotFoundException('Repository not found');
      const { rows: [repository] } = await client.query<{ fullName: string; baseBranch: string }>(
        `SELECT owner || '/' || repo_name AS "fullName", default_branch AS "baseBranch"
         FROM repositories WHERE project_id = $1 AND id = $2`, [projectId, repositoryId]);
      if (!repository) throw new NotFoundException('Repository not found');
      const requirement = requirementId ? await this.projects.requirement(client, projectId, requirementId) : undefined;
      if (!this.model.available()) throw new ServiceUnavailableException('Planning provider is unconfigured');
      const registry = await this.registry.view(projectId, client);
      const assignments: PlanRecord['assignments'] = {};
      for (const role of planningRoles) {
        const assignment = this.registry.snapshot(registry, role, this.model.defaultModel());
        if (!assignment) throw new ConflictException('A required planning role is disabled');
        if (!assignment.model) throw new ServiceUnavailableException('Planning model is unconfigured');
        assignments[role] = assignment;
      }
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
          request, project: project.name, repository: repository.fullName, baseBranch: repository.baseBranch, requirement,
        }, assignments]);
      await this.tasks.event(client, task, 'task.created', { actorId: actor.id, status: task.status });
      await this.tasks.event(client, task, 'agent.plan_queued', { actorId: actor.id, ...(requirement && { requirementId: requirement.id }) });
      return publicPlan(row);
    });
  }

  async get(actor: Account, projectId: string, taskId: string) {
    const project = await this.projects.access(actor.id, projectId);
    await this.tasks.find(projectId, taskId);
    const { rows: [row] } = await this.db.pool.query<PlanRecord>(
      `SELECT ${planFields} FROM task_agent_plans WHERE project_id = $1 AND task_id = $2`, [projectId, taskId]);
    return { plan: row ? publicPlan(row, project.role === 'owner') : null };
  }

  async retry(actor: Account, projectId: string, taskId: string) {
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { write: true, active: true }, client);
      const task = await this.tasks.find(projectId, taskId, client);
      if (task.status !== 'PLANNING' || task.archivedAt) throw new ConflictException('Task is no longer in planning');
      if (!this.model.available()) throw new ServiceUnavailableException('Planning provider is unconfigured');
      const { rows: [row] } = await client.query<PlanRecord>(
        `UPDATE task_agent_plans SET state = 'queued', error = NULL, failure_category = NULL, updated_at = now()
         WHERE project_id = $1 AND task_id = $2 AND state = 'failed' RETURNING ${planFields}`, [projectId, taskId]);
      if (!row) throw new ConflictException('There is no failed plan for this task');
      await this.tasks.event(client, task, 'agent.plan_retried', { actorId: actor.id, stage: planningRoles[row.steps.length] });
      return publicPlan(row);
    });
  }

  async runNext() {
    if (this.busy) return false;
    this.busy = true;
    try {
      const { rows: [row] } = await this.db.pool.query<PlanRecord>(
        `WITH next AS (
          SELECT a.task_id FROM task_agent_plans a JOIN projects p ON p.id = a.project_id
          WHERE p.status = 'active' AND (a.state = 'queued' OR (a.state = 'running' AND a.lease_expires_at < now()))
          ORDER BY a.updated_at LIMIT 1 FOR UPDATE OF a SKIP LOCKED
         )
         UPDATE task_agent_plans a SET state = 'running', lease_id = gen_random_uuid(),
           lease_expires_at = now() + interval '2 minutes', updated_at = now()
         FROM next WHERE a.task_id = next.task_id
         RETURNING a.task_id AS "taskId", a.project_id AS "projectId", a.state, a.input, a.assignments,
           a.steps, a.error, a.failure_category AS "failureCategory", a.lease_id AS "leaseId"`);
      if (!row) return false;

      const role = planningRoles[row.steps.length];
      const agent = row.assignments[role];
      const developers = developerRoles.filter((item) => row.assignments[item]);
      let step: AgentPlan['steps'][number];
      let usage: ModelUsage | undefined;
      try {
        if (!agent) throw new Error('Planning role is missing');
        const { requirement, ...intake } = row.input;
        const response = await this.model.generate(role, agent, {
          ...intake, priorSteps: row.steps, availableDevelopers: developers,
          ...(requirement && { approvedRequirement: { title: requirement.title, excerpt: requirement.excerpt } }),
        });
        usage = response.usage;
        const output = validatePlanningOutput(role, response.output);
        if ('developer' in output && !developers.includes(output.developer)) {
          throw new PlanningFailure('invalid_structured_output');
        }
        step = { role, version: agent.version, model: agent.model, output };
      } catch (error) {
        await this.settle(row, null, usage, error instanceof PlanningFailure ? error.category : 'unknown');
        return true;
      }
      await this.settle(row, step, usage);
      return true;
    } finally {
      this.busy = false;
    }
  }

  private async settle(row: PlanRecord, step: AgentPlan['steps'][number] | null, usage?: ModelUsage,
    category?: PlanningFailureCategory) {
    await this.db.transaction(async (client) => {
      const { rows: [project] } = await client.query<{ status: string }>(
        'SELECT status FROM projects WHERE id = $1 FOR UPDATE', [row.projectId]);
      const current = await client.query(
        "SELECT 1 FROM task_agent_plans WHERE task_id = $1 AND lease_id = $2 AND state = 'running' FOR UPDATE",
        [row.taskId, row.leaseId]);
      if (!current.rowCount) return;
      const task = await this.tasks.find(row.projectId, row.taskId, client);
      if (usage) await this.tasks.event(client, task, 'agent.model_usage', { role: planningRoles[row.steps.length], usage });
      if (task.status !== 'PLANNING' || task.archivedAt || project?.status !== 'active') {
        await this.saveProgress(client, row, 'cancelled', row.steps, null);
        await this.tasks.event(client, task, 'agent.plan_cancelled', {});
        return;
      }
      if (!step) {
        const error = 'planning_step_failed';
        await this.saveProgress(client, row, 'failed', row.steps, error, category);
        await this.tasks.event(client, task, 'agent.plan_failed', { role: planningRoles[row.steps.length], error });
        return;
      }

      const steps = [...row.steps, step];
      await this.tasks.event(client, task, 'agent.step_completed', { role: step.role, version: step.version, model: step.model });
      if (step.role !== 'ARCHITECT') {
        await this.saveProgress(client, row, 'queued', steps, null);
        return;
      }
      const product = steps[1].output as ProductPlan;
      const architecture = step.output as ArchitecturePlan;
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
       lease_id = NULL, lease_expires_at = NULL, updated_at = now() WHERE task_id = $1`,
      [row.taskId, state, JSON.stringify(steps), error, category]);
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
