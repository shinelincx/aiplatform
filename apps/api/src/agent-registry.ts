import {
  BadRequestException, Body, ConflictException, Controller, Get, Inject, Injectable,
  NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, UseGuards,
} from '@nestjs/common';
import { isUsableSkillVersion, isWorkerId, type Account, type AgentAssignment, type AgentRegistry,
  type AgentRole, type AgentVersion, type ProjectSkill, type SkillDecision, type SkillEvaluation, type SkillVersion } from '@ado/shared';
import type { Pool, PoolClient } from 'pg';
import { CurrentAccount, SessionGuard } from './auth';
import { Database, isUniqueViolation } from './database';
import { objectInput, textInput } from './input';
import { ProjectsService } from './projects';

const templates: Record<AgentRole, string> = {
  PROJECT_DIRECTOR: 'Identify the project objective, boundaries, dependencies and unresolved questions from the request.',
  PRODUCT_MANAGER: 'Write a scoped user story, requirements and observable acceptance criteria. Record important assumptions.',
  ARCHITECT: 'Propose implementation steps, risks and verification. Select a developer from the enabled roles provided in the input. Mention repository assumptions explicitly.',
  UI_UX_DESIGNER: 'Describe user flows, interface states and accessibility requirements.',
  FRONTEND_DEVELOPER: 'Implement approved interface changes and verify behavior and accessibility.',
  BACKEND_DEVELOPER: 'Implement the approved changes and verify relevant behaviors and data boundaries.',
  QA_ENGINEER: 'Independently evaluate acceptance criteria against the actual patch and check evidence. Identify gaps and regressions.',
  RELEASE_ENGINEER: 'Summarize verified changes, release risks and rollback considerations.',
};

function agentRole(value: string): AgentRole {
  if (!Object.hasOwn(templates, value)) throw new NotFoundException('Agent role not found');
  return value as AgentRole;
}

function enabledInput(value: unknown) {
  if (typeof value !== 'boolean') throw new BadRequestException('Expected an enabled flag');
  return value;
}

const skillVersionColumns = `version, instructions, evaluation, decision,
  CASE
    WHEN legacy_eligible THEN 'legacy'
    WHEN decision->>'decision' = 'approved' THEN 'approved'
    WHEN decision->>'decision' = 'rejected' THEN 'rejected'
    WHEN evaluation->>'result' = 'passed' THEN 'awaiting_approval'
    WHEN evaluation->>'result' = 'failed' THEN 'evaluation_failed'
    ELSE 'pending_evaluation'
  END AS status`;

function requireUsableSkills(registry: AgentRegistry, refs: AgentVersion['skills']) {
  for (const { id, version } of refs) {
    const skill = registry.skills.find((item) => item.id === id)?.versions.find((item) => item.version === version);
    if (!skill) throw new NotFoundException('Skill version not found in this project');
    if (!isUsableSkillVersion(skill)) throw new ConflictException('Skill version requires evaluation and approval before use');
  }
}

@Injectable()
export class AgentRegistryService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  async view(projectId: string, client: Pool | PoolClient = this.db.pool): Promise<AgentRegistry> {
    const { rows: [registry] } = await client.query<{
      settings: { role: AgentRole; enabled: boolean; activeVersion: number }[];
      versions: (AgentVersion & { role: AgentRole })[];
      skills: ProjectSkill[];
    }>(
      `SELECT
        ARRAY(SELECT jsonb_build_object('role', role, 'enabled', enabled, 'activeVersion', active_version)
          FROM project_agent_settings WHERE project_id = $1) AS settings,
        ARRAY(SELECT jsonb_build_object('role', role, 'version', version, 'model', model,
          'instructions', instructions, 'skills', skills)
          FROM project_agent_versions WHERE project_id = $1 ORDER BY version DESC) AS versions,
        ARRAY(SELECT jsonb_build_object('id', s.id, 'name', s.name, 'enabled', s.enabled, 'versions',
          (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.version DESC)
           FROM (SELECT ${skillVersionColumns} FROM project_skill_versions
             WHERE project_id = s.project_id AND skill_id = s.id) v))
          FROM project_skills s WHERE s.project_id = $1 ORDER BY s.name) AS skills`, [projectId]);
    return {
      modelConfigured: Boolean(process.env.ADO_AGENT_API_KEY?.trim()),
      skills: registry.skills,
      agents: (Object.keys(templates) as AgentRole[]).map((role) => {
        const setting = registry.settings.find((row) => row.role === role);
        return {
          role, enabled: setting?.enabled ?? true, activeVersion: setting?.activeVersion ?? 1, template: templates[role],
          versions: [
            ...registry.versions.filter((row) => row.role === role).map(({ version, model, instructions, skills }) =>
              ({ version, model, instructions, skills })),
            { version: 1, model: '', instructions: '', skills: [] },
          ],
        };
      }),
    };
  }

  async list(actor: Account, projectId: string) {
    await this.projects.access(actor.id, projectId);
    return this.view(projectId);
  }

  snapshot(registry: AgentRegistry, role: AgentRole, defaultModel: string): AgentAssignment | undefined {
    const agent = registry.agents.find((item) => item.role === role);
    if (!agent?.enabled) return;
    const config = agent.versions.find(({ version }) => version === agent.activeVersion);
    if (!config) throw new Error('Missing active agent version');
    const skills = config.skills.flatMap(({ id, version }) => {
      const skill = registry.skills.find((item) => item.id === id);
      const content = skill?.versions.find((item) => item.version === version);
      return skill?.enabled && content && isUsableSkillVersion(content)
        ? [{ name: skill.name, version: content.version, instructions: content.instructions }] : [];
    });
    return {
      role, version: config.version, model: config.model || defaultModel,
      instructions: [agent.template, config.instructions].filter(Boolean).join('\n\n'), skills,
    };
  }

  async publish(actor: Account, projectId: string, roleValue: string, body: unknown) {
    const role = agentRole(roleValue);
    const input = objectInput(body);
    const instructions = textInput(input.instructions ?? '', 'agent instructions', 8000, true);
    const model = textInput(input.model ?? '', 'model', 100, true);
    if (model && !/^[\w.-]+$/.test(model)) throw new BadRequestException('Invalid model identifier');
    const requested = input.skills ?? [];
    if (!Array.isArray(requested) || requested.length > 8) throw new BadRequestException('Invalid skill selection');
    const skills = (requested as unknown[]).map((value) => {
      const { id, version } = objectInput(value);
      if (!isWorkerId(id) || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > 2147483647) {
        throw new BadRequestException('Invalid skill version');
      }
      return { id: id.toLowerCase(), version };
    });
    if (new Set(skills.map(({ id }) => id)).size !== skills.length) throw new BadRequestException('Duplicate skill');
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const registry = await this.view(projectId, client);
      const agent = registry.agents.find((item) => item.role === role)!;
      requireUsableSkills(registry, skills);
      const version = agent.versions[0].version + 1;
      await this.setAgent(client, projectId, role, agent.enabled, version);
      await client.query(
        `INSERT INTO project_agent_versions (project_id, role, version, model, instructions, skills)
         VALUES ($1,$2,$3,$4,$5,$6)`, [projectId, role, version, model, instructions, JSON.stringify(skills)]);
      await this.projects.audit(client, actor.id, projectId, 'agent.version_published', projectId,
        { role, version, enabled: agent.enabled });
      return { role, version, model, instructions, skills };
    });
  }

  async configure(actor: Account, projectId: string, roleValue: string, body: unknown) {
    const role = agentRole(roleValue);
    const input = objectInput(body);
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const registry = await this.view(projectId, client);
      const agent = registry.agents.find((item) => item.role === role)!;
      const activeVersion = input.activeVersion ?? agent.activeVersion;
      const enabled = input.enabled === undefined ? agent.enabled : enabledInput(input.enabled);
      const selected = agent.versions.find(({ version }) => version === activeVersion);
      if (!selected) throw new NotFoundException('Agent version not found');
      if (enabled || selected.version !== agent.activeVersion) requireUsableSkills(registry, selected.skills);
      await this.setAgent(client, projectId, role, enabled, selected.version);
      await this.projects.audit(client, actor.id, projectId, 'agent.settings_updated', projectId,
        { role, version: selected.version, enabled });
      return { ...agent, enabled, activeVersion };
    });
  }

  private async setAgent(client: PoolClient, projectId: string, role: AgentRole, enabled: boolean, activeVersion: number) {
    await client.query(
      `INSERT INTO project_agent_settings (project_id, role, enabled, active_version) VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, role) DO UPDATE SET enabled = EXCLUDED.enabled, active_version = EXCLUDED.active_version`,
      [projectId, role, enabled, activeVersion],
    );
  }

  async publishSkill(actor: Account, projectId: string, body: unknown, id?: string) {
    const input = objectInput(body);
    const instructions = textInput(input.instructions, 'skill instructions', 4000);
    try {
      return await this.db.transaction(async (client) => {
        await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
        const name = id ? null : textInput(input.name, 'skill name', 100);
        const { rows: [skill] } = id
          ? await client.query<Pick<ProjectSkill, 'id' | 'name' | 'enabled'>>(
            'SELECT id, name, enabled FROM project_skills WHERE project_id = $1 AND id = $2', [projectId, id])
          : await client.query<Pick<ProjectSkill, 'id' | 'name' | 'enabled'>>(
            'INSERT INTO project_skills (project_id, name) VALUES ($1,$2) RETURNING id, name, enabled', [projectId, name]);
        if (!skill) throw new NotFoundException('Skill not found');
        const { rows: [published] } = await client.query<SkillVersion>(
          `INSERT INTO project_skill_versions (project_id, skill_id, version, instructions)
           SELECT $1, $2, COALESCE(max(version), 0) + 1, $3 FROM project_skill_versions
           WHERE project_id = $1 AND skill_id = $2 RETURNING ${skillVersionColumns}`, [projectId, skill.id, instructions]);
        await this.projects.audit(client, actor.id, projectId, 'skill.version_published', skill.id,
          { version: published.version });
        return { ...skill, ...published };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Skill name already exists');
      throw error;
    }
  }

  async evaluateSkill(actor: Account, projectId: string, id: string, version: number, body: unknown) {
    const input = objectInput(body);
    const { result } = input;
    if (result !== 'passed' && result !== 'failed') throw new BadRequestException('Invalid skill evaluation result');
    const evidence = textInput(input.evidence, 'skill evaluation evidence', 2000);
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const current = await this.readSkillVersion(client, projectId, id, version);
      if (current.evaluation?.result === result && current.evaluation.evidence === evidence) return current;
      if (current.status !== 'pending_evaluation') throw new ConflictException('Skill evaluation is already recorded or not required');
      const evaluation: SkillEvaluation = { result, evidence, recordedBy: actor.name, recordedAt: new Date().toISOString() };
      const { rows: [saved] } = await client.query<SkillVersion>(
        `UPDATE project_skill_versions SET evaluation = $4 WHERE project_id = $1 AND skill_id = $2 AND version = $3
         RETURNING ${skillVersionColumns}`, [projectId, id, version, evaluation]);
      await this.projects.audit(client, actor.id, projectId, 'skill.version_evaluated', id, { version });
      return saved;
    });
  }

  async decideSkill(actor: Account, projectId: string, id: string, version: number, body: unknown) {
    const { decision } = objectInput(body);
    if (decision !== 'approved' && decision !== 'rejected') throw new BadRequestException('Invalid skill decision');
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const current = await this.readSkillVersion(client, projectId, id, version);
      if (current.decision?.decision === decision) return current;
      if (current.status !== 'awaiting_approval' && !(current.status === 'evaluation_failed' && decision === 'rejected')) {
        throw new ConflictException('A decision requires an evaluated and undecided skill version; approval requires a pass');
      }
      const record: SkillDecision = { decision, decidedBy: actor.name, decidedAt: new Date().toISOString() };
      const { rows: [saved] } = await client.query<SkillVersion>(
        `UPDATE project_skill_versions SET decision = $4 WHERE project_id = $1 AND skill_id = $2 AND version = $3
         RETURNING ${skillVersionColumns}`, [projectId, id, version, record]);
      const event = decision === 'approved' ? 'skill.version_approved' : 'skill.version_rejected';
      await this.projects.audit(client, actor.id, projectId, event, id, { version });
      return saved;
    });
  }

  private async readSkillVersion(client: PoolClient, projectId: string, id: string, version: number) {
    if (!Number.isSafeInteger(version) || version < 1 || version > 2147483647) {
      throw new BadRequestException('Invalid skill version');
    }
    const { rows: [current] } = await client.query<SkillVersion>(
      `SELECT ${skillVersionColumns} FROM project_skill_versions WHERE project_id = $1 AND skill_id = $2 AND version = $3`,
      [projectId, id, version],
    );
    if (!current) throw new NotFoundException('Skill version not found in this project');
    return current;
  }

  async configureSkill(actor: Account, projectId: string, id: string, body: unknown) {
    const enabled = enabledInput(objectInput(body).enabled);
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      if (enabled) {
        const registry = await this.view(projectId, client);
        const bindings = registry.agents.filter((agent) => agent.enabled).flatMap((agent) =>
          agent.versions.find(({ version }) => version === agent.activeVersion)?.skills ?? []);
        requireUsableSkills(registry, bindings.filter((skill) => skill.id === id.toLowerCase()));
      }
      const updated = await client.query('UPDATE project_skills SET enabled = $3 WHERE project_id = $1 AND id = $2',
        [projectId, id, enabled]);
      if (!updated.rowCount) throw new NotFoundException('Skill not found');
      await this.projects.audit(client, actor.id, projectId, 'skill.settings_updated', id, { enabled });
      return { id, enabled };
    });
  }
}

@Controller('projects/:projectId/agent-registry')
@UseGuards(SessionGuard)
export class AgentRegistryController {
  constructor(@Inject(AgentRegistryService) private readonly registry: AgentRegistryService) {}

  @Get()
  list(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.registry.list(actor, projectId);
  }

  @Post('agents/:role/versions')
  publish(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('role') role: string, @Body() body: unknown) {
    return this.registry.publish(actor, projectId, role, body);
  }

  @Put('agents/:role')
  configure(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('role') role: string, @Body() body: unknown) {
    return this.registry.configure(actor, projectId, role, body);
  }

  @Post('skills')
  createSkill(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() body: unknown) {
    return this.registry.publishSkill(actor, projectId, body);
  }

  @Post('skills/:id/versions')
  publishSkill(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.registry.publishSkill(actor, projectId, body, id);
  }

  @Put('skills/:id')
  configureSkill(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.registry.configureSkill(actor, projectId, id, body);
  }

  @Put('skills/:id/versions/:version/evaluation')
  evaluateSkill(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string, @Param('version', ParseIntPipe) version: number, @Body() body: unknown) {
    return this.registry.evaluateSkill(actor, projectId, id, version, body);
  }

  @Put('skills/:id/versions/:version/decision')
  decideSkill(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string, @Param('version', ParseIntPipe) version: number, @Body() body: unknown) {
    return this.registry.decideSkill(actor, projectId, id, version, body);
  }
}
