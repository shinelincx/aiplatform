import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject,
  Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UseGuards,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { canTransitionTask, developerRoles, taskPriorities, type Account, type AgentAssignment, type ArchitecturePlan,
  type AgentRole, type DecisionQuestion, type DeveloperRole, type KnowledgeSnapshot, type ModelUsage,
  type RequirementContent, type Task, type TaskDecision, type TaskDetail,
  type TaskEvent, type TaskPriority, type TaskStatus } from '@ado/shared';
import { AgentRegistryService } from './agent-registry';
import { CurrentAccount, SessionGuard } from './auth';
import { Database, isUniqueViolation } from './database';
import type { PlanWorkflow } from './plan-workflow';
import { objectInput, textInput } from './input';
import { ProjectsService } from './projects';

export const planExecutionTarget = "jsonb_build_object('repositoryId', id, 'checks', check_plan, 'independentChecks', independent_checks)";

const taskColumns = `id, project_id AS "projectId", task_code AS code, title, description, status, priority,
  repository_id AS "repositoryId", parent_task_id AS "parentTaskId",
  acceptance_criteria AS "acceptanceCriteria", archived_at AS "archivedAt", created_at AS "createdAt",
  CASE WHEN approved_developer IS NOT NULL THEN jsonb_build_object(
    'role', approved_developer->'role', 'version', approved_developer->'version', 'model', approved_developer->'model'
  ) END AS developer`;
export const runFailure = `CASE WHEN r.status IN ('failed', 'timed_out') THEN
  COALESCE((SELECT e.payload FROM execution_events e
    WHERE e.run_id = r.id AND e.sequence = r.last_sequence AND e.kind = 'failed'),
    jsonb_build_object('code', CASE
      WHEN r.status = 'timed_out' THEN 'worker_timeout'
      WHEN r.verification_report->>'passed' = 'false' THEN 'checks_failed'
      ELSE 'worker_error' END))
  || jsonb_build_object('runId', r.id) END`;
const taskReadColumns = `${taskColumns},
  CASE WHEN tasks.status IN ('FAILED', 'TIMEOUT') THEN
    (SELECT ${runFailure} FROM execution_runs r WHERE r.project_id = tasks.project_id AND r.task_id = tasks.id
     ORDER BY r.created_at DESC, r.id DESC LIMIT 1) END AS "executionFailure",
  (SELECT p.steps->2->'output' FROM task_agent_plans p WHERE p.project_id = tasks.project_id
   AND p.task_id = tasks.id AND p.state = 'completed' AND NOT p.input ? 'workflow') AS architecture,
  (SELECT p.input->'workflow'->'questions' FROM task_agent_plans p WHERE p.project_id = tasks.project_id
   AND p.task_id = tasks.id AND p.state <> 'cancelled') AS "plannedQuestions",
  (SELECT e.payload->'decisions' FROM task_events e WHERE e.project_id = tasks.project_id AND e.task_id = tasks.id
   AND e.event_type = 'task.decisions_submitted' AND NOT EXISTS (
     SELECT 1 FROM task_events reset WHERE reset.project_id = e.project_id AND reset.task_id = e.task_id
       AND reset.id > e.id AND reset.event_type = 'task.status_changed' AND reset.payload->>'to' = 'PLANNING'
   ) ORDER BY e.id DESC LIMIT 1) AS "submittedDecisions"`;

type TaskRead = {
  architecture: ArchitecturePlan | null;
  plannedQuestions: TaskDecision[] | null;
  submittedDecisions: TaskDecision[] | null;
};

function legacyDecisions(plan: ArchitecturePlan): DecisionQuestion[] {
  const questions = plan.steps.flatMap((step) => {
    const match = /^(?:提交人工审批|待人工确认|实施前待确认)[:：]\s*(?:确认)?([^。]+)/u.exec(step);
    return match ? match[1].split(/、|，(?:以及)?|；/u).map((question) => question.trim()).filter(Boolean) : [];
  });
  if (questions.length) {
    for (const risk of plan.risks) {
      const match = /^([^。；]{1,150}?)(?:待确认|未确认)(?=[。；]|$)/u.exec(risk);
      if (match) questions.push(match[1]);
    }
  }
  return [...new Set(questions)].slice(0, 8).map((question) => ({
    question, options: ['本期暂缓，沿用现有行为', '仅核实现状并记录差异，具体改动另行确认'],
  }));
}

function withDecisions<T extends Task>({ architecture, plannedQuestions, submittedDecisions, ...task }: T & TaskRead) {
  const failure = task.executionFailure;
  const checkLegacy = ['WAITING_APPROVAL', 'READY'].includes(task.status)
    || (task.status === 'FAILED' && failure?.code === 'no_changes');
  const planned = architecture?.decisions ?? (architecture && checkLegacy ? legacyDecisions(architecture) : []);
  const decisions = new Map((plannedQuestions ?? submittedDecisions ?? []).map((item) => [item.question, item]));
  for (const [index, item] of planned.entries()) {
    if (!decisions.has(item.question)) decisions.set(item.question, { ...item, id: `plan:${index}` });
  }
  if (task.status === 'FAILED' && failure?.decisions) {
    for (const [index, item] of failure.decisions.entries()) {
      const id = `${failure.runId}:${index}`;
      if (decisions.get(item.question)?.id !== id) decisions.set(item.question, { ...item, id });
    }
  }
  return { ...task, decisions: [...decisions.values()] };
}

export function requireTaskDecisions(task: Task) {
  if (task.decisions?.some(({ answer }) => !answer)) {
    throw new ConflictException({ code: 'pending-decisions', message: 'Resolve outstanding decisions before approval or dispatch' });
  }
}
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
    const { rows } = await this.db.projectQuery<Task & TaskRead>(projectId,
      `SELECT ${taskReadColumns} FROM tasks WHERE project_id = $1
       ORDER BY archived_at NULLS FIRST, priority, created_at DESC`, [projectId],
    );
    return rows.map((row) => withDecisions<Task>(row));
  }

  async find(projectId: string, id: string, client?: PoolClient): Promise<TaskDetail> {
    if (!client) return this.db.projectTransaction(projectId, (scoped) => this.find(projectId, id, scoped));
    const { rows: [task] } = await client.query<TaskDetail & TaskRead>(
      `SELECT ${taskReadColumns}, ARRAY(SELECT d.depends_on_task_id FROM task_dependencies d
         WHERE d.project_id = $1 AND d.task_id = $2 ORDER BY d.depends_on_task_id) AS dependencies
       FROM tasks WHERE project_id = $1 AND id = $2`, [projectId, id],
    );
    if (!task) throw new NotFoundException('Task not found');
    return withDecisions<TaskDetail>(task);
  }

  async get(actor: Account, projectId: string, id: string) {
    await this.projects.access(actor.id, projectId);
    return this.find(projectId, id);
  }

  async history(actor: Account, projectId: string, id: string) {
    await this.get(actor, projectId, id);
    const { rows } = await this.db.projectQuery<TaskEvent>(projectId,
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
      const workflow = await this.planWorkflow(client, task);
      if (workflow && to === 'PLANNING') throw new ConflictException('Use the Agent planning retry action');
      if (task.archivedAt || running.has(task.status) || !canTransitionTask(task.status, to)) {
        throw new ConflictException('Invalid task transition');
      }
      if (task.status === 'PLANNING' && to !== 'CANCELLED' && await this.hasActiveAgentPlan(client, task)) {
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
        requireTaskDecisions(task);
        const blocked = await client.query(
          `SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
           WHERE d.project_id = $1 AND d.task_id = $2 AND t.status <> 'COMPLETED' LIMIT 1`, [projectId, id],
        );
        if (blocked.rowCount) throw new ConflictException('Prerequisite tasks must be completed');
        const planned = await this.plannedDevelopment(client, task);
        if (workflow && (!planned?.proposal || planned.proposal.version !== input.planVersion)) {
          throw new ConflictException({ code: 'stale-plan-version', message: 'Review the current plan version before approval' });
        }
        if (planned?.proposal) {
          const { rows: [binding] } = await client.query<{ target: PlanWorkflow['approvedTarget'] }>(
            `SELECT ${planExecutionTarget} AS target FROM repositories WHERE project_id = $1 AND id = $2 FOR SHARE`,
            [projectId, task.repositoryId]);
          if (!binding?.target) throw new ConflictException('The plan repository is no longer bound');
          await client.query(
            `UPDATE task_agent_plans SET input = jsonb_set(input, '{workflow}',
              input->'workflow' || $2::jsonb) WHERE task_id = $1`,
            [id, { approvedVersion: planned.proposal.version, approvedTarget: binding.target }]);
          await this.event(client, task, 'agent.plan_version_approved', {
            actorId: actor.id, version: planned.proposal.version, commit: planned.proposal.commit, target: binding.target,
          });
        }
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
      return { ...updated, dependencies: task.dependencies, decisions: task.decisions, executionFailure: task.executionFailure };
    });
  }

  async submitDecisions(actor: Account, projectId: string, id: string, body: unknown) {
    const { answers } = objectInput(body);
    if (!Array.isArray(answers) || answers.length > 16) throw new BadRequestException('Invalid decision answers');
    return this.db.transaction(async (client) => {
      const project = await this.projects.access(actor.id, projectId, { write: true, active: true }, client);
      const task = await this.find(projectId, id, client);
      const workflow = await this.planWorkflow(client, task);
      if (workflow && project.role !== 'owner') {
        await this.projects.access(actor.id, projectId, { owner: true }, client);
      }
      const pending = (task.decisions ?? []).filter(({ answer }) => !answer);
      const statuses = workflow ? ['PLANNING', 'FAILED'] : ['WAITING_APPROVAL', 'READY', 'FAILED'];
      if (task.archivedAt || !statuses.includes(task.status)
        || !pending.length || !answers.length || (!workflow && answers.length !== pending.length)) {
        throw new ConflictException('Task decisions changed or cannot be submitted');
      }
      const byId = new Map(answers.map((entry) => {
        const { id, answer } = objectInput(entry);
        return [textInput(id, 'decision ID', 100), textInput(answer, 'decision answer', 1000)];
      }));
      const pendingIds = new Set(pending.map(({ id }) => id));
      if (byId.size !== answers.length || [...byId.keys()].some((key) => !pendingIds.has(key))) {
        throw new ConflictException('Task decisions changed');
      }
      const decisions = (task.decisions ?? []).map((item) => ({ ...item, answer: byId.get(item.id) ?? item.answer }));
      if (workflow) {
        const reviewers = pending.filter(({ id }) => byId.has(id)).flatMap((item) => item.reviewers
          ?? (workflow.proposal?.design ? ['ARCHITECT', 'UI_UX_DESIGNER'] as const : ['ARCHITECT'] as const));
        workflow.questions = decisions;
        workflow.affected = [...new Set([...workflow.affected, ...reviewers])];
        const resume = (workflow.queue.length === 0 || task.status === 'FAILED')
          && !workflow.blockers?.length && decisions.every(({ answer }) => answer);
        if (resume) {
          workflow.queue = ['revise'];
          delete workflow.proposal;
          delete workflow.approvedVersion;
          delete workflow.approvedTarget;
          await client.query("UPDATE tasks SET status = 'PLANNING', approved_developer = NULL, updated_at = now() WHERE id = $1", [id]);
          if (task.status !== 'PLANNING') {
            await this.event(client, task, 'task.status_changed', { actorId: actor.id, from: task.status, to: 'PLANNING' });
          }
        }
        await client.query(
          `UPDATE task_agent_plans SET input = jsonb_set(input, '{workflow}', $2::jsonb),
           state = CASE WHEN $3 THEN 'queued' ELSE state END, error = CASE WHEN $3 THEN NULL ELSE error END,
           updated_at = now() WHERE task_id = $1`, [id, workflow, resume]);
        await this.event(client, task, 'task.decisions_submitted', {
          actorId: actor.id, decisions, ...(task.executionFailure && { runId: task.executionFailure.runId }),
        });
        return;
      }
      await client.query(
        `UPDATE tasks SET status = 'WAITING_APPROVAL', updated_at = now(), approved_developer = NULL
         WHERE project_id = $1 AND id = $2`, [projectId, id]);
      await this.event(client, task, 'task.decisions_submitted', {
        actorId: actor.id, decisions, ...(task.executionFailure && { runId: task.executionFailure.runId }),
      });
      if (task.status !== 'WAITING_APPROVAL') {
        await this.event(client, task, 'task.status_changed', { actorId: actor.id, from: task.status, to: 'WAITING_APPROVAL' });
      }
    });
  }

  async planWorkflow(client: PoolClient, task: Task) {
    const { rows: [row] } = await client.query<{ workflow: PlanWorkflow | null }>(
      "SELECT input->'workflow' AS workflow FROM task_agent_plans WHERE project_id = $1 AND task_id = $2 AND state <> 'cancelled'",
      [task.projectId, task.id]);
    return row?.workflow;
  }

  async plannedDevelopment(client: PoolClient, task: Task) {
    const { rows: [planned] } = await client.query<{
      plan: ArchitecturePlan; agent: AgentAssignment; qa: AgentAssignment | null; requirement: RequirementContent | null;
      knowledge: KnowledgeSnapshot[] | null;
      proposal: PlanWorkflow['proposal'] | null; approvedVersion: string | null; approvedTarget: PlanWorkflow['approvedTarget'] | null;
    }>(
      `SELECT COALESCE(input->'workflow'->'proposal'->'architecture', steps->2->'output') AS plan,
         assignments->(COALESCE(input->'workflow'->'proposal'->'architecture', steps->2->'output')->>'developer') AS agent,
         input->'workflow'->'proposal' AS proposal, input->'workflow'->>'approvedVersion' AS "approvedVersion",
         input->'workflow'->'approvedTarget' AS "approvedTarget",
         assignments->'QA_ENGINEER' AS qa,
         CASE WHEN input ? 'requirement' THEN jsonb_build_object(
           'title', input->'requirement'->>'title', 'excerpt', input->'requirement'->>'excerpt'
         ) END AS requirement, input->'knowledge' AS knowledge
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
      await this.archiveTask(client, await this.find(projectId, id, client), actor.id);
    });
  }

  async archiveTask(client: PoolClient, task: Task, actorId: string) {
    const { projectId, id } = task;
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
      throw new ConflictException({ code: 'task_archive_dependency', message: 'An active task depends on this task' });
    }
    await client.query('UPDATE tasks SET archived_at = now(), updated_at = now() WHERE project_id = $1 AND id = $2',
      [projectId, id]);
    await this.event(client, task, 'task.archived', { actorId });
  }

  async event(client: PoolClient, task: Task, eventType: string, payload: object) {
    await client.query('INSERT INTO task_events (project_id, task_id, event_type, payload) VALUES ($1,$2,$3,$4)',
      [task.projectId, task.id, eventType, payload]);
  }

  async recordModelUsage(client: PoolClient, task: Task, attemptId: string,
    reading: { role: AgentRole; usage: ModelUsage; runId?: string }) {
    await client.query(
      `INSERT INTO task_events (project_id, task_id, event_type, payload)
       VALUES ($1,$2,'agent.model_usage',$3)
       ON CONFLICT (project_id, task_id, (payload->>'attemptId'))
       WHERE event_type = 'agent.model_usage' AND payload ? 'attemptId' DO NOTHING`,
      [task.projectId, task.id, { ...reading, attemptId }]);
  }

  private async hasActiveAgentPlan(client: PoolClient, task: Task) {
    const plan = await client.query(
      `SELECT 1 FROM task_agent_plans WHERE task_id = $1
       AND (state IN ('queued','running','failed') OR ($2 AND state = 'completed' AND input ? 'workflow'))`,
      [task.id, task.status === 'REJECTED']);
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

  @Post(':id/decisions')
  @HttpCode(204)
  submitDecisions(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.tasks.submitDecisions(actor, projectId, id, body);
  }

  @Post(':id/archive')
  @HttpCode(204)
  archive(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.archive(actor, projectId, id);
  }
}
