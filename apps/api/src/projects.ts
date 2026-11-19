import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject,
  Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { Account, Project, ProjectMember, ProjectRequirement } from '@ado/shared';
import { AuthService, CurrentAccount, SessionGuard } from './auth';
import { Database, isUniqueViolation } from './database';
import { objectInput, textInput } from './input';

const requirementFields = `id, title, excerpt, reference_url AS "referenceUrl", approved_by AS "approvedBy",
  approved_at AS "approvedAt"`;

function requirementUrl(value: unknown) {
  const text = textInput(value, 'requirement URL', 2000);
  const url = URL.parse(text);
  if (!url || url.protocol !== 'https:' || url.username || url.password) throw new BadRequestException('Invalid requirement URL');
  return url.href;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async list(userId: string) {
    const { rows } = await this.db.pool.query<Project>(
      `SELECT p.id, p.code, p.name, p.description, p.status, m.role
       FROM projects p JOIN project_members m ON m.project_id = p.id
       WHERE m.user_id = $1 ORDER BY p.status, p.code`, [userId],
    );
    return rows;
  }

  async access(userId: string, projectId: string, options: { owner?: boolean; write?: boolean; active?: boolean } = {},
    client: Pool | PoolClient = this.db.pool) {
    const lock = client === this.db.pool ? '' : 'FOR UPDATE OF p, m';
    const { rows: [project] } = await client.query<Project>(
      `SELECT p.id, p.code, p.name, p.description, p.status, m.role
       FROM projects p JOIN project_members m ON m.project_id = p.id
       WHERE m.user_id = $1 AND p.id = $2 ${lock}`, [userId, projectId],
    );
    if (!project) throw new NotFoundException('Project not found');
    if (options.owner && project.role !== 'owner') throw new ForbiddenException('Project owner required');
    if (options.write && project.role === 'viewer') throw new ForbiddenException('Project write access required');
    if (options.active && project.status !== 'active') throw new ConflictException('Project is archived');
    return project;
  }

  async create(actor: Account, body: unknown) {
    this.auth.requireAdmin(actor);
    const input = objectInput(body);
    const code = textInput(input.code, 'code', 50).toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]*$/.test(code)) {
      throw new ConflictException('Project code must start with a letter and use letters, digits, hyphens or underscores');
    }
    const name = textInput(input.name, 'name', 200);
    const description = textInput(input.description ?? '', 'description', 4000, true);
    try {
      return await this.db.transaction(async (client) => {
        const { rows: [project] } = await client.query<Omit<Project, 'role'>>(
          `INSERT INTO projects (code, name, description) VALUES ($1, $2, $3)
           RETURNING id, code, name, description, status`, [code, name, description],
        );
        await client.query(
          `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [project.id, actor.id],
        );
        await this.audit(client, actor.id, project.id, 'project.created', project.id);
        return { ...project, role: 'owner' };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Project code already in use');
      throw error;
    }
  }

  async update(actor: Account, projectId: string, body: unknown) {
    const input = objectInput(body);
    return this.db.transaction(async (client) => {
      const project = await this.access(actor.id, projectId, { owner: true }, client);
      const name = input.name === undefined ? project.name : textInput(input.name, 'name', 200);
      const description = input.description === undefined
        ? project.description : textInput(input.description, 'description', 4000, true);
      if (project.status === 'archived') throw new ConflictException('Project is archived');
      await client.query(
        'UPDATE projects SET name = $2, description = $3, updated_at = now() WHERE id = $1',
        [projectId, name, description],
      );
      await this.audit(client, actor.id, projectId, 'project.updated', projectId);
      return { ...project, name, description };
    });
  }

  async archive(actor: Account, projectId: string) {
    await this.db.transaction(async (client) => {
      const project = await this.access(actor.id, projectId, { owner: true }, client);
      if (project.status === 'archived') return;
      await client.query("UPDATE projects SET status = 'archived', updated_at = now() WHERE id = $1", [projectId]);
      await client.query(
        `WITH cancelled AS (
          UPDATE task_agent_plans SET state = 'cancelled', lease_id = NULL, lease_expires_at = NULL,
            error = NULL, failure_category = NULL, updated_at = now()
          WHERE project_id = $1 AND state IN ('queued','running','failed') RETURNING project_id, task_id
         )
         INSERT INTO task_events (project_id, task_id, event_type, payload)
         SELECT project_id, task_id, 'agent.plan_cancelled', jsonb_build_object('actorId', $2::uuid) FROM cancelled`,
        [projectId, actor.id]);
      await client.query(
        `WITH cancelled AS (
          UPDATE execution_qa q SET state = 'cancelled', lease_id = NULL, lease_expires_at = NULL, updated_at = now()
          FROM execution_runs r WHERE q.run_id = r.id AND r.project_id = $1 AND q.state IN ('queued','running','failed')
          RETURNING r.project_id, r.task_id, r.id
         )
         INSERT INTO task_events (project_id, task_id, event_type, payload)
         SELECT project_id, task_id, 'agent.qa_cancelled', jsonb_build_object('actorId', $2::uuid, 'runId', id) FROM cancelled`,
        [projectId, actor.id]);
      await this.audit(client, actor.id, projectId, 'project.archived', projectId);
    });
  }

  async members(actor: Account, projectId: string) {
    await this.access(actor.id, projectId, { owner: true });
    const { rows } = await this.db.pool.query<ProjectMember>(
      `SELECT u.id, u.email, u.name, m.role FROM project_members m
       JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY u.email`, [projectId],
    );
    return rows;
  }

  async listRequirements(actor: Account, projectId: string) {
    await this.access(actor.id, projectId);
    const { rows } = await this.db.pool.query<ProjectRequirement>(
      `SELECT ${requirementFields} FROM project_requirements WHERE project_id = $1 AND retired_at IS NULL
       ORDER BY approved_at DESC, id`, [projectId]);
    return rows;
  }

  async requirement(client: PoolClient, projectId: string, requirementId: string) {
    const { rows: [requirement] } = await client.query<ProjectRequirement>(
      `SELECT ${requirementFields} FROM project_requirements WHERE project_id = $1 AND id = $2 AND retired_at IS NULL`,
      [projectId, requirementId]);
    if (!requirement) throw new NotFoundException('Active requirement not found in this project');
    return requirement;
  }

  async approveRequirement(actor: Account, projectId: string, body: unknown) {
    const input = objectInput(body);
    const title = textInput(input.title, 'requirement title', 200);
    const excerpt = textInput(input.excerpt, 'approved excerpt', 4000);
    const referenceUrl = requirementUrl(input.referenceUrl);
    return this.db.transaction(async (client) => {
      await this.access(actor.id, projectId, { owner: true, active: true }, client);
      const { rows: [requirement] } = await client.query<ProjectRequirement>(
        `INSERT INTO project_requirements (project_id, title, excerpt, reference_url, approved_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING ${requirementFields}`, [projectId, title, excerpt, referenceUrl, actor.name]);
      await this.audit(client, actor.id, projectId, 'requirement.approved', requirement.id);
      return requirement;
    });
  }

  async retireRequirement(actor: Account, projectId: string, requirementId: string) {
    await this.db.transaction(async (client) => {
      await this.access(actor.id, projectId, { owner: true, active: true }, client);
      await this.requirement(client, projectId, requirementId);
      await client.query('UPDATE project_requirements SET retired_at = now() WHERE id = $1 AND project_id = $2',
        [requirementId, projectId]);
      await this.audit(client, actor.id, projectId, 'requirement.retired', requirementId);
    });
  }

  async setMember(actor: Account, projectId: string, userId: string, body: unknown) {
    const { role } = objectInput(body);
    if (role !== 'member' && role !== 'viewer') throw new ForbiddenException('Assignable roles are member and viewer');
    return this.db.transaction(async (client) => {
      await this.access(actor.id, projectId, { owner: true, active: true }, client);
      if (actor.id === userId) throw new ForbiddenException('The project owner role is fixed');
      const result = await client.query(
        `INSERT INTO project_members (project_id, user_id, role)
         SELECT $1, id, $3 FROM users WHERE id = $2 AND status = 'active'
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [projectId, userId, role],
      );
      if (!result.rowCount) throw new NotFoundException('Active user not found');
      await this.audit(client, actor.id, projectId, 'project.member_set', userId);
    });
  }

  async removeMember(actor: Account, projectId: string, userId: string) {
    await this.db.transaction(async (client) => {
      await this.access(actor.id, projectId, { owner: true, active: true }, client);
      if (actor.id === userId) throw new ForbiddenException('The project owner role is fixed');
      const removed = await client.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
        [projectId, userId]);
      if (removed.rowCount) await this.audit(client, actor.id, projectId, 'project.member_removed', userId);
    });
  }

  async audit(client: PoolClient, actorId: string, projectId: string, action: string, resourceId: string) {
    await client.query(
      'INSERT INTO audit_logs (actor_id, project_id, action, resource_id) VALUES ($1, $2, $3, $4)',
      [actorId, projectId, action, resourceId],
    );
  }
}

@Controller('projects')
@UseGuards(SessionGuard)
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Get()
  list(@CurrentAccount() actor: Account) {
    return this.projects.list(actor.id);
  }

  @Post()
  create(@CurrentAccount() actor: Account, @Body() body: unknown) {
    return this.projects.create(actor, body);
  }

  @Get(':id')
  get(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.access(actor.id, id);
  }

  @Get(':id/requirements')
  requirements(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.listRequirements(actor, id);
  }

  @Post(':id/requirements')
  approveRequirement(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.projects.approveRequirement(actor, id, body);
  }

  @Delete(':id/requirements/:requirementId')
  @HttpCode(204)
  retireRequirement(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string,
    @Param('requirementId', ParseUUIDPipe) requirementId: string) {
    return this.projects.retireRequirement(actor, id, requirementId);
  }

  @Patch(':id')
  update(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.projects.update(actor, id, body);
  }

  @Post(':id/archive')
  @HttpCode(204)
  archive(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.archive(actor, id);
  }

  @Get(':id/members')
  members(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.members(actor, id);
  }

  @Put(':id/members/:userId')
  @HttpCode(204)
  setMember(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string, @Body() body: unknown) {
    return this.projects.setMember(actor, id, userId, body);
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  removeMember(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string) {
    return this.projects.removeMember(actor, id, userId);
  }
}
