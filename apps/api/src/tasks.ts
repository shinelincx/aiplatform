import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject,
  Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UseGuards,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { canTransitionTask, developerRoles, taskPriorities, type Account, type AgentAssignment, type ArchitecturePlan,
  type DeveloperRole, type RequirementContent, type Task, type TaskDetail, type TaskEvent, type TaskPriority, type TaskStatus } from '@ado/shared';
import { AgentRegistryService } from './agent-registry';
import { CurrentAccount, SessionGuard } from './auth';
import { Database, isUniqueViolation } from './database';
import { objectInput, textInput } from './input';
import { ProjectsService } from './projects';

const taskColumns = `id, project_id AS "projectId", task_code AS code, title, description, status, priority,
  repository_id AS "repositoryId", parent_task_id AS "parentTaskId",
  acceptance_criteria AS "acceptanceCriteria", archived_at AS "archivedAt", created_at AS "createdAt",
  CASE WHEN approved_developer IS NOT NULL THEN jsonb_build_object(
    'role', approved_developer->'role', 'version', approved_developer->'version', 'model', approved_developer->'model'
  ) END AS developer`;
const editable = new Set<TaskStatus>(['CREATED', 'PLANNING', 'BLOCKED', 'REJECTED']);
const userTransitions = new Set<TaskStatus>(['PLANNING', 'WAITING_APPROVAL', 'READY', 'REJECTED', 'CANCELLED']);
const running = new Set<TaskStatus>(['QUEUED', 'RUNNING', 'TESTING', 'REVIEW', 'MERGED', 'RETRYING']);

function optionalId(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException('Expected a UUID');
  }
  return value.toLowerCase();
}

function taskInput(body: unknown, existing?: TaskDetail) {
  const input = objectInput(body);
  const title = textInput(input.title ?? existing?.title, 'title', 255);
  const description = textInput(input.description ?? existing?.description, 'description', 12000);
  const priority = input.priority ?? existing?.priority ?? 'P1';
  if (!taskPriorities.includes(priority as TaskPriority)) throw new BadRequestException('Invalid priority');
  const criteria = input.acceptanceCriteria ?? existing?.acceptanceCriteria ?? [];
  if (!Array.isArray(criteria) || criteria.length > 30) throw new BadRequestException('Invalid acceptance criteria');
  const acceptanceCriteria = criteria.map((value) => textInput(value, 'acceptance criterion', 2000));
  const repositoryId = optionalId('repositoryId' in input ? input.repositoryId : existing?.repositoryId);
  const parentTaskId = optionalId('parentTaskId' in input ? input.parentTaskId : existing?.parentTaskId);
  const prerequisites = input.dependencies ?? existing?.dependencies ?? [];
  if (!Array.isArray(prerequisites) || prerequisites.length > 50) throw new BadRequestException('Invalid dependencies');
  const dependencies = [...new Set(prerequisites.map((value) => {
    const id = optionalId(value);
    if (!id) throw new BadRequestException('Dependency ID is required');
    return id;
  }))];
  return { title, description, priority, acceptanceCriteria, repositoryId, parentTaskId, dependencies };
}

@Injectable()
export class TasksService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(AgentRegistryService) private readonly registry: AgentRegistryService,
  ) {}

  async list(actor: Account, projectId: string) {
    await this.projects.access(actor.id, projectId);
    const { rows } = await this.db.pool.query<Task>(
      `SELECT ${taskColumns} FROM tasks WHERE project_id = $1
       ORDER BY archived_at NULLS FIRST, priority, created_at DESC`, [projectId],
    );
    return rows;
  }

  async find(projectId: string, id: string, client: Pool | PoolClient = this.db.pool): Promise<TaskDetail> {
    const { rows: [task] } = await client.query<TaskDetail>(
      `SELECT ${taskColumns}, ARRAY(SELECT d.depends_on_task_id FROM task_dependencies d
         WHERE d.project_id = $1 AND d.task_id = $2 ORDER BY d.depends_on_task_id) AS dependencies
       FROM tasks WHERE project_id = $1 AND id = $2`, [projectId, id],
    );
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  async get(actor: Account, projectId: string, id: string) {
    await this.projects.access(actor.id, projectId);
    return this.find(projectId, id);
  }

  async history(actor: Account, projectId: string, id: string) {
    await this.get(actor, projectId, id);
    const { rows } = await this.db.pool.query<TaskEvent>(
      `SELECT id::text, event_type AS "eventType", payload, created_at AS "createdAt"
       FROM task_events WHERE project_id = $1 AND task_id = $2 ORDER BY task_events.id`, [projectId, id],
    );
    return rows;
  }

  async save(actor: Account, projectId: string, body: unknown, id?: string) {
    try {
      return await this.db.transaction(async (client) => {
        await this.projects.access(actor.id, projectId, { write: true, active: true }, client);
        const existing = id ? await this.find(projectId, id, client) : undefined;
        if (existing && (existing.archivedAt || !editable.has(existing.status))) {
          throw new ConflictException('Task cannot be edited in its current state');
        }
        if (existing && await this.hasActiveAgentPlan(client, existing)) {
          throw new ConflictException('An Agent plan is already managing this task');
        }
        const input = taskInput(body, existing);
        await this.validateLinks(client, projectId, input, id);
        const values = [input.title, input.description, input.priority, JSON.stringify(input.acceptanceCriteria),
          input.repositoryId, input.parentTaskId, projectId];
        let task: Task;
        if (id) {
          const result = await client.query<Task>(
            `UPDATE tasks SET title = $1, description = $2, priority = $3, acceptance_criteria = $4,
              repository_id = $5, parent_task_id = $6, updated_at = now() WHERE project_id = $7 AND id = $8
             RETURNING ${taskColumns}`, [...values, id],
          );
          task = result.rows[0];
          await client.query('DELETE FROM task_dependencies WHERE project_id = $1 AND task_id = $2', [projectId, id]);
        } else {
          const code = textInput(objectInput(body).code, 'code', 50).toUpperCase();
          if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) throw new BadRequestException('Invalid task code');
          const result = await client.query<Task>(
            `INSERT INTO tasks (title, description, priority, acceptance_criteria, repository_id,
              parent_task_id, project_id, task_code, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             RETURNING ${taskColumns}`, [...values, code, actor.id],
          );
          task = result.rows[0];
        }
        await client.query(
          `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
           SELECT $1, $2, unnest($3::uuid[])`, [projectId, task.id, input.dependencies],
        );
        await this.event(client, task, id ? 'task.updated' : 'task.created', { actorId: actor.id, status: task.status });
        return { ...task, dependencies: input.dependencies };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Task code already in use');
      throw error;
    }
  }

  private async validateLinks(client: PoolClient, projectId: string, input: ReturnType<typeof taskInput>, id?: string) {
    if (input.repositoryId) {
      const found = await client.query('SELECT 1 FROM repositories WHERE project_id = $1 AND id = $2',
        [projectId, input.repositoryId]);
      if (!found.rowCount) throw new NotFoundException('Repository not found in this project');
    }
    const links = [...new Set([...input.dependencies, ...(input.parentTaskId ? [input.parentTaskId] : [])])];
    if (links.length === 0) return;
    const result = await client.query('SELECT id FROM tasks WHERE project_id = $1 AND id = ANY($2::uuid[])',
      [projectId, links]);
    if (result.rowCount !== links.length) throw new NotFoundException('Linked task not found in this project');
    if (!id) return;
    const cycle = await client.query(
      `WITH RECURSIVE prerequisites(id) AS (
         SELECT unnest($2::uuid[])
         UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN prerequisites n ON d.task_id = n.id
         WHERE d.project_id = $1
       ), ancestors(id) AS (
         SELECT $3::uuid WHERE $3 IS NOT NULL
         UNION SELECT t.parent_task_id FROM tasks t JOIN ancestors n ON t.id = n.id
         WHERE t.project_id = $1 AND t.parent_task_id IS NOT NULL
       )
       SELECT id FROM prerequisites WHERE id = $4 UNION SELECT id FROM ancestors WHERE id = $4`,
      [projectId, input.dependencies, input.parentTaskId, id],
    );
    if (cycle.rowCount) throw new ConflictException('Task link would create a cycle');
  }

  async transition(actor: Account, projectId: string, id: string, body: unknown) {
    const input = objectInput(body);
    const to = input.status as TaskStatus;
    if (!userTransitions.has(to)) throw new BadRequestException('Transition is reserved for the execution workflow');
    const role = developerRoles.find((candidate) => candidate === input.developerRole);
    if (input.developerRole != null && (to !== 'READY' || !role)) {
      throw new BadRequestException('Invalid developer role for task approval');
    }
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, {
        write: true, active: true, owner: to === 'READY' || to === 'REJECTED',
      }, client);
      const task = await this.find(projectId, id, client);
      if (task.archivedAt || running.has(task.status) || !canTransitionTask(task.status, to)) {
        throw new ConflictException('Invalid task transition');
      }
      if (to !== 'CANCELLED' && await this.hasActiveAgentPlan(client, task)) {
        throw new ConflictException('An Agent plan is already managing this task');
      }
      if (to === 'CANCELLED' || to === 'PLANNING') {
        const cancelled = await client.query(
          `UPDATE task_agent_plans SET state = 'cancelled', lease_id = NULL, lease_expires_at = NULL, error = NULL, failure_category = NULL,
           updated_at = now() WHERE project_id = $1 AND task_id = $2 AND state <> 'cancelled'`,
          [projectId, id]);
        if (cancelled.rowCount) await this.event(client, task, 'agent.plan_cancelled', { actorId: actor.id });
      }
      if (to === 'WAITING_APPROVAL' && task.acceptanceCriteria.length === 0) {
        throw new ConflictException('Acceptance criteria are required before review');
      }
      let approved: AgentAssignment | undefined;
      if (to === 'READY') {
        const blocked = await client.query(
          `SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
           WHERE d.project_id = $1 AND d.task_id = $2 AND t.status <> 'COMPLETED' LIMIT 1`, [projectId, id],
        );
        if (blocked.rowCount) throw new ConflictException('Prerequisite tasks must be completed');
        const planned = await this.plannedDevelopment(client, task);
        if (planned && role && role !== planned.agent.role) throw new ConflictException('Developer differs from the Agent plan');
        approved = planned?.agent ?? await this.selectDeveloper(client, projectId, role);
        await this.projects.audit(client, actor.id, projectId, 'task.approved', id);
      }
      if (to === 'REJECTED') await this.projects.audit(client, actor.id, projectId, 'task.rejected', id);
      const { rows: [updated] } = await client.query<Task>(
        `UPDATE tasks SET status = $3, updated_at = now(),
           approved_developer = CASE WHEN $3 = 'PLANNING' THEN NULL ELSE COALESCE($4, approved_developer) END
         WHERE project_id = $1 AND id = $2 RETURNING ${taskColumns}`, [projectId, id, to, approved ?? null]);
      await this.event(client, task, 'task.status_changed', { actorId: actor.id, from: task.status, to,
        ...(updated.developer && { developer: updated.developer.role, developerVersion: updated.developer.version }) });
      return { ...updated, dependencies: task.dependencies };
    });
  }

  async plannedDevelopment(client: PoolClient, task: Task) {
    const { rows: [planned] } = await client.query<{
      plan: ArchitecturePlan; agent: AgentAssignment; qa: AgentAssignment | null; requirement: RequirementContent | null;
    }>(
      `SELECT steps->2->'output' AS plan, assignments->(steps->2->'output'->>'developer') AS agent,
         assignments->'QA_ENGINEER' AS qa,
         CASE WHEN input ? 'requirement' THEN jsonb_build_object(
           'title', input->'requirement'->>'title', 'excerpt', input->'requirement'->>'excerpt'
         ) END AS requirement
       FROM task_agent_plans WHERE project_id = $1 AND task_id = $2 AND state = 'completed'`, [task.projectId, task.id]);
    if (planned && !planned.agent) throw new ConflictException('Approved developer assignment is missing');
    return planned;
  }

  async approvedDeveloper(client: PoolClient, task: Task, planned?: AgentAssignment): Promise<AgentAssignment> {
    const { rows: [row] } = await client.query<{ agent: AgentAssignment | null }>(
      'SELECT approved_developer AS agent FROM tasks WHERE project_id = $1 AND id = $2', [task.projectId, task.id]);
    if (row?.agent) return row.agent;
    const agent = planned ?? await this.selectDeveloper(client, task.projectId);
    await client.query('UPDATE tasks SET approved_developer = $3 WHERE project_id = $1 AND id = $2',
      [task.projectId, task.id, agent]);
    return agent;
  }

  private async selectDeveloper(client: PoolClient, projectId: string, role?: DeveloperRole) {
    const registry = await this.registry.view(projectId, client);
    const choices: DeveloperRole[] = role ? [role] : ['BACKEND_DEVELOPER', 'FRONTEND_DEVELOPER'];
    for (const choice of choices) {
      const agent = this.registry.snapshot(registry, choice, '');
      if (agent) return agent;
    }
    throw new ConflictException('No eligible developer Agent is enabled in this project');
  }

  async archive(actor: Account, projectId: string, id: string) {
    await this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const task = await this.find(projectId, id, client);
      if (task.archivedAt) return;
      if (!['CREATED', 'CANCELLED', 'COMPLETED'].includes(task.status)) {
        throw new ConflictException('Only draft, cancelled or completed tasks can be archived');
      }
      const blocked = await client.query(
        `SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
         WHERE d.project_id = $1 AND d.depends_on_task_id = $2
           AND t.archived_at IS NULL AND t.status NOT IN ('COMPLETED', 'CANCELLED') LIMIT 1`, [projectId, id],
      );
      if (task.status !== 'COMPLETED' && blocked.rowCount) {
        throw new ConflictException('An active task depends on this task');
      }
      await client.query('UPDATE tasks SET archived_at = now(), updated_at = now() WHERE project_id = $1 AND id = $2',
        [projectId, id]);
      await this.event(client, task, 'task.archived', { actorId: actor.id });
    });
  }

  async event(client: PoolClient, task: Task, eventType: string, payload: object) {
    await client.query('INSERT INTO task_events (project_id, task_id, event_type, payload) VALUES ($1,$2,$3,$4)',
      [task.projectId, task.id, eventType, payload]);
  }

  private async hasActiveAgentPlan(client: PoolClient, task: Task) {
    if (task.status !== 'PLANNING') return false;
    const plan = await client.query(
      "SELECT 1 FROM task_agent_plans WHERE task_id = $1 AND state IN ('queued','running','failed')", [task.id]);
    return Boolean(plan.rowCount);
  }
}

@Controller('projects/:projectId/tasks')
@UseGuards(SessionGuard)
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Get()
  list(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.tasks.list(actor, projectId);
  }

  @Post()
  create(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() body: unknown) {
    return this.tasks.save(actor, projectId, body);
  }

  @Get(':id')
  get(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.get(actor, projectId, id);
  }

  @Patch(':id')
  update(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.tasks.save(actor, projectId, body, id);
  }

  @Get(':id/events')
  events(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.history(actor, projectId, id);
  }

  @Post(':id/transition')
  @HttpCode(200)
  transition(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.tasks.transition(actor, projectId, id, body);
  }

  @Post(':id/archive')
  @HttpCode(204)
  archive(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.archive(actor, projectId, id);
  }
}
