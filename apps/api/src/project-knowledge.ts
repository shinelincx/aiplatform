import {
  BadRequestException, Body, ConflictException, Controller, Get, Inject, Injectable, NotFoundException,
  Param, ParseUUIDPipe, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isWorkerId, knowledgeKinds, type Account, type DesignEvidence, type KnowledgeEntry,
  type KnowledgeKind, type KnowledgeSnapshot, type KnowledgeVersion } from '@ado/shared';
import type { PoolClient } from 'pg';
import { CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { objectInput, textInput } from './input';
import { ProjectsService } from './projects';

const snapshotColumns = `v.id, v.entry_id AS "entryId", v.version, e.kind, e.title, v.excerpt,
  v.source_url AS "sourceUrl", v.source_revision AS "sourceRevision", v.excerpt_hash AS "excerptHash"`;
const entryColumns = 'id, kind, title, active_version_id AS "activeVersionId"';
const versionColumns = `${snapshotColumns}, v.decision, u.name AS "decidedBy", v.decided_at AS "decidedAt",
  v.version_note AS "versionNote", v.design_evidence AS "designEvidence"`;

function httpsReference(value: unknown, label: string) {
  const source = URL.parse(textInput(value, label, 2000));
  if (!source || source.protocol !== 'https:' || source.username || source.password) {
    throw new BadRequestException(`Invalid ${label}`);
  }
  return source.href;
}

function knowledgeKind(value: unknown): KnowledgeKind {
  const kind = knowledgeKinds.find(candidate => candidate === value);
  if (!kind) throw new BadRequestException('Invalid knowledge kind');
  return kind;
}

export async function selectKnowledgeVersions(client: PoolClient, projectId: string, ids: string[]) {
  const { rows } = await client.query<KnowledgeSnapshot>(
    `SELECT ${snapshotColumns} FROM project_knowledge_versions v JOIN project_knowledge e
       ON e.project_id = v.project_id AND e.id = v.entry_id AND e.active_version_id = v.id
     WHERE v.project_id = $1 AND v.id = ANY($2::uuid[]) AND v.decision = 'approved'
     ORDER BY array_position($2::uuid[], v.id)`, [projectId, ids],
  );
  if (rows.length !== ids.length) throw new NotFoundException('Active knowledge version not found in this project');
  return rows;
}

@Injectable()
export class ProjectKnowledgeService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  async list(actor: Account, projectId: string, query: string | undefined, kind: string | undefined, history: boolean) {
    const project = await this.projects.access(actor.id, projectId);
    const text = textInput(query ?? '', 'knowledge search', 160, true);
    const { rows } = await this.db.pool.query<KnowledgeEntry>(
      `SELECT e.id, e.kind, e.title, e.active_version_id AS "activeVersionId", v.version, v.id AS "matchedVersionId"
       FROM project_knowledge e
       JOIN LATERAL (
         SELECT id, version FROM project_knowledge_versions v WHERE v.project_id = e.project_id AND v.entry_id = e.id
           AND (v.decision = 'approved' OR $4)
           AND ($5 OR (v.id = e.active_version_id AND v.decision = 'approved'))
           AND (strpos(lower(e.title), lower($2)) > 0 OR strpos(lower(v.excerpt), lower($2)) > 0
             OR strpos(lower(v.source_url), lower($2)) > 0)
         ORDER BY version DESC LIMIT 1
       ) v ON true
       WHERE e.project_id = $1 AND ($3::text IS NULL OR e.kind = $3)
       ORDER BY e.title, e.id`, [projectId, text, kind ? knowledgeKind(kind) : null, project.role === 'owner', history],
    );
    return rows;
  }

  async detail(actor: Account, projectId: string, entryId: string) {
    const project = await this.projects.access(actor.id, projectId);
    const { rows: [entry] } = await this.db.pool.query<Omit<KnowledgeEntry, 'version' | 'matchedVersionId'>>(
      `SELECT ${entryColumns} FROM project_knowledge WHERE project_id = $1 AND id = $2`, [projectId, entryId],
    );
    if (!entry) throw new NotFoundException('Knowledge entry not found');
    const { rows: versions } = await this.db.pool.query<KnowledgeVersion>(
      `SELECT ${versionColumns}
       FROM project_knowledge_versions v JOIN project_knowledge e ON e.project_id = v.project_id AND e.id = v.entry_id
       LEFT JOIN users u ON u.id = v.decided_by
       WHERE v.project_id = $1 AND v.entry_id = $2 AND (v.decision = 'approved' OR $3)
       ORDER BY v.version DESC`, [projectId, entryId, project.role === 'owner'],
    );
    if (!versions.length) throw new NotFoundException('Knowledge entry not found');
    return { ...entry, versions };
  }

  async create(actor: Account, projectId: string, body: unknown) {
    const input = objectInput(body);
    const kind = knowledgeKind(input.kind);
    const title = textInput(input.title, 'knowledge title', 200);
    return this.db.transaction(async client => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const { rows: [entry] } = await client.query<{ id: string }>(
        'INSERT INTO project_knowledge (project_id, kind, title) VALUES ($1,$2,$3) RETURNING id', [projectId, kind, title],
      );
      return this.insertVersion(client, actor.id, projectId, entry.id, kind, input);
    });
  }

  async addVersion(actor: Account, projectId: string, entryId: string, body: unknown) {
    const input = objectInput(body);
    return this.db.transaction(async client => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const { rows: [entry] } = await client.query<{ kind: KnowledgeKind }>(
        'SELECT kind FROM project_knowledge WHERE project_id = $1 AND id = $2', [projectId, entryId],
      );
      if (!entry) throw new NotFoundException('Knowledge entry not found');
      return this.insertVersion(client, actor.id, projectId, entryId, entry.kind, input);
    });
  }

  async decide(actor: Account, projectId: string, entryId: string, versionId: string, body: unknown) {
    const { decision } = objectInput(body);
    if (decision !== 'approved' && decision !== 'rejected') throw new BadRequestException('Invalid knowledge decision');
    return this.db.transaction(async client => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const { rows: [version] } = await client.query<{ version: number; decision: KnowledgeVersion['decision'] }>(
        'SELECT version, decision FROM project_knowledge_versions WHERE project_id = $1 AND entry_id = $2 AND id = $3',
        [projectId, entryId, versionId],
      );
      if (!version) throw new NotFoundException('Knowledge version not found');
      if (version.decision && version.decision !== decision) throw new ConflictException('Knowledge version already reviewed');
      if (!version.decision) {
        await client.query(
          `UPDATE project_knowledge_versions SET decision = $4, decided_by = $5, decided_at = now()
           WHERE project_id = $1 AND entry_id = $2 AND id = $3`, [projectId, entryId, versionId, decision, actor.id],
        );
        await this.projects.audit(client, actor.id, projectId, `knowledge.${decision}`, entryId, { version: version.version, versionId });
      }
      return { id: versionId, decision };
    });
  }

  async activate(actor: Account, projectId: string, entryId: string, body: unknown) {
    const { versionId, expectedVersionId } = objectInput(body);
    if (versionId !== null && !isWorkerId(versionId)) throw new BadRequestException('Invalid knowledge version');
    if (expectedVersionId !== undefined && expectedVersionId !== null && !isWorkerId(expectedVersionId)) {
      throw new BadRequestException('Invalid current knowledge version');
    }
    return this.db.transaction(async client => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const { rows: [entry] } = await client.query<{ activeVersionId: string | null }>(
        'SELECT active_version_id AS "activeVersionId" FROM project_knowledge WHERE project_id = $1 AND id = $2', [projectId, entryId],
      );
      if (!entry) throw new NotFoundException('Knowledge entry not found');
      if (entry.activeVersionId === versionId) return { activeVersionId: versionId };
      if (expectedVersionId !== undefined && expectedVersionId !== entry.activeVersionId) {
        throw new ConflictException('The active knowledge version has changed');
      }
      if (versionId) {
        const { rows: [version] } = await client.query<{ decision: KnowledgeVersion['decision'] }>(
          'SELECT decision FROM project_knowledge_versions WHERE project_id = $1 AND entry_id = $2 AND id = $3',
          [projectId, entryId, versionId],
        );
        if (!version) throw new NotFoundException('Knowledge version not found');
        if (version.decision !== 'approved') throw new ConflictException('Only an approved knowledge version can be activated');
      }
      await client.query('UPDATE project_knowledge SET active_version_id = $3 WHERE project_id = $1 AND id = $2',
        [projectId, entryId, versionId]);
      await this.projects.audit(client, actor.id, projectId, versionId ? 'knowledge.activated' : 'knowledge.retired',
        entryId, { versionId, previousVersionId: entry.activeVersionId });
      return { activeVersionId: versionId };
    });
  }

  private async insertVersion(client: PoolClient, actorId: string, projectId: string, entryId: string, kind: KnowledgeKind,
    input: Record<string, unknown>) {
    const excerpt = textInput(input.excerpt, 'knowledge excerpt', 4000);
    const sourceUrl = httpsReference(input.sourceUrl, 'knowledge source URL');
    const sourceRevision = textInput(input.sourceRevision, 'source revision', 120);
    const versionNote = textInput(input.versionNote ?? '', 'version note', 1000, true);
    const excerptHash = createHash('sha256').update(excerpt).digest('hex');
    const evidence = kind === 'design_rule' ? await this.designEvidence(client, projectId, input.designEvidence) : null;
    const { rows: [version] } = await client.query<{ id: string; version: number }>(
      `INSERT INTO project_knowledge_versions
       (project_id, entry_id, version, excerpt, source_url, source_revision, excerpt_hash, version_note, design_evidence)
       SELECT $1, $2, COALESCE(max(version),0) + 1, $3, $4, $5, $6, $7, $8 FROM project_knowledge_versions
       WHERE project_id = $1 AND entry_id = $2 RETURNING id, version`,
      [projectId, entryId, excerpt, sourceUrl, sourceRevision, excerptHash, versionNote, evidence],
    );
    await this.projects.audit(client, actorId, projectId, 'knowledge.version_created', entryId,
      { version: version.version, versionId: version.id, excerptHash });
    return { entryId, ...version };
  }

  private async designEvidence(client: PoolClient, projectId: string, body: unknown): Promise<DesignEvidence> {
    const { repositoryId, runId, ...input } = objectInput(body);
    if (!isWorkerId(repositoryId) || (runId !== undefined && !isWorkerId(runId))) {
      throw new BadRequestException('Invalid design evidence identifiers');
    }
    const implementationCommit = textInput(input.implementationCommit, 'implementation commit', 40);
    if (!/^[0-9a-f]{40}$/.test(implementationCommit)) throw new BadRequestException('A full implementation commit is required');
    const reportUrl = httpsReference(input.reportUrl, 'verification report URL');
    const { rows: [repository] } = await client.query<{ url: string }>(
      'SELECT repository_url AS url FROM repositories WHERE project_id = $1 AND id = $2', [projectId, repositoryId],
    );
    if (!repository) throw new NotFoundException('Evidence repository not found in this project');
    let archive: DesignEvidence['archive'];
    if (runId) {
      const { rows } = await client.query<NonNullable<DesignEvidence['archive']>>(
        `SELECT r.task_id AS "taskId", r.id AS "runId", a.sha256 AS "patchHash" FROM execution_runs r
         JOIN execution_reviews h ON h.run_id = r.id AND h.decision = 'approved'
         JOIN execution_artifacts a ON a.run_id = r.id AND a.sha256 = r.verification_report->>'patchHash'
         WHERE r.project_id = $1 AND r.repository_id = $2 AND r.id = $3`, [projectId, repositoryId, runId],
      );
      [archive] = rows;
      if (!archive) throw new NotFoundException('Approved archive not found in this project and repository');
    }
    return { repositoryId, repositoryUrl: repository.url, implementationCommit, reportUrl, ...(archive && { archive }) };
  }
}

@Controller('projects/:projectId/knowledge')
@UseGuards(SessionGuard)
export class ProjectKnowledgeController {
  constructor(@Inject(ProjectKnowledgeService) private readonly knowledge: ProjectKnowledgeService) {}

  @Get()
  list(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('q') q?: string, @Query('kind') kind?: string, @Query('history') history?: string) {
    return this.knowledge.list(actor, projectId, q, kind, history === '1');
  }

  @Get(':entryId')
  detail(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string) {
    return this.knowledge.detail(actor, projectId, entryId);
  }

  @Post()
  create(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() body: unknown) {
    return this.knowledge.create(actor, projectId, body);
  }

  @Post(':entryId/versions')
  addVersion(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string, @Body() body: unknown) {
    return this.knowledge.addVersion(actor, projectId, entryId, body);
  }

  @Put(':entryId/versions/:versionId/decision')
  decide(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string, @Param('versionId', ParseUUIDPipe) versionId: string, @Body() body: unknown) {
    return this.knowledge.decide(actor, projectId, entryId, versionId, body);
  }

  @Put(':entryId/active-version')
  activate(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string, @Body() body: unknown) {
    return this.knowledge.activate(actor, projectId, entryId, body);
  }
}
