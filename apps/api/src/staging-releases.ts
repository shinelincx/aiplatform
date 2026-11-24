
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode,
  Inject, Param, ParseUUIDPipe, Post, ServiceUnavailableException, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { stagingMigrationFiles, stagingRepository, type Account, type StagingRelease, type StagingReleaseStatus } from '@ado/shared';
import { AuthService, CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { ProjectsService } from './projects';

const shaPattern = /^[a-f0-9]{40}$/;
const imagePattern = /^ghcr\.io\/shinelincx\/aiplatform@sha256:[a-f0-9]{64}$/;
const runPattern = /^[1-9][0-9]{0,15}$/;
const pullPattern = /^[1-9][0-9]{0,8}$/;
const github = 'https://api.github.com/repos/' + stagingRepository;
const statusColumns = 'state, decided_at AS "decidedAt", decided_by AS "decidedBy", deployment_run AS "deploymentRun", deployment_attempt AS "deploymentAttempt"';
type ReleaseRow = StagingRelease & { deploymentAttempt: string | null };

function object(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid release data');
  return body as Record<string, unknown>;
}

function input(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new BadRequestException('Invalid release data');
  return value;
}

function authorizeWorkflow(authorization: string | undefined) {
  const secret = process.env.ADO_STAGING_RELEASE_SECRET;
  if (!secret || secret.length < 32) throw new ServiceUnavailableException('Staging approval is not configured');
  const hash = (text: string) => createHash('sha256').update(text).digest();
  if (!authorization || !timingSafeEqual(hash(authorization), hash('Bearer ' + secret))) throw new UnauthorizedException();
}

async function verifyMain(sha: string) {
  const response = await fetch(github + '/git/ref/heads/main', {
    redirect: 'error', signal: AbortSignal.timeout(3500), headers: { Accept: 'application/vnd.github+json' },
  }).catch(() => null);
  if (!response?.ok) throw new ServiceUnavailableException('Cannot verify the current main revision');
  if ((await response.json()).object?.sha !== sha) throw new ConflictException('The approved revision must still be on main');
}

@Controller()
export class StagingReleasesController {
  constructor(@Inject(Database) private readonly db: Database,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ProjectsService) private readonly projects: ProjectsService) {}

  private async reconcile(release: Pick<ReleaseRow, 'sha' | 'state' | 'deploymentRun' | 'deploymentAttempt'>) {
    const { sha, state, deploymentRun, deploymentAttempt } = release;
    const token = process.env.ADO_STAGING_WORKFLOW_TOKEN;
    if (state !== 'deploying' || !deploymentRun || !deploymentAttempt || !token) return state;
    // A cancelled run or an unavailable API during rollout can prevent the result callback.
    const url = github + '/actions/runs/' + deploymentRun + '/attempts/' + deploymentAttempt + '/jobs';
    const response = await fetch(url, {
      redirect: 'error', signal: AbortSignal.timeout(2000),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    }).catch(() => null);
    if (!response?.ok) return state;
    const data = await response.json().catch(() => null) as {
      jobs?: { name: string; status: string; steps?: { name: string; conclusion: string }[] }[];
    } | null;
    const job = data?.jobs?.find(row => row.name === 'deploy' && row.status === 'completed');
    if (!job) return state;
    const result = job.steps?.some(step => step.name === 'Transfer and deploy approved image' && step.conclusion === 'success')
      ? 'succeeded' : 'failed';
    const updated = await this.db.pool.query(
      "UPDATE staging_releases SET state = $4 WHERE sha = $1 AND deployment_run = $2 AND deployment_attempt = $3 AND state = 'deploying'",
      [sha, deploymentRun, deploymentAttempt, result],
    );
    return updated.rowCount ? result : state;
  }

  @Get('staging-releases')
  @UseGuards(SessionGuard)
  async list(@CurrentAccount() actor: Account) {
    this.auth.requireAdmin(actor);
    const { rows } = await this.db.pool.query<ReleaseRow>(
      `SELECT sha, base_sha AS "baseSha", image, source_run AS "sourceRun", pulls, files, requested_at AS "requestedAt",
         note, ${statusColumns} FROM staging_releases ORDER BY requested_at DESC, sha LIMIT 50`,
    );
    const releases = await Promise.all(rows.map(async ({ deploymentAttempt, ...release }) =>
      ({ ...release, state: await this.reconcile({ ...release, deploymentAttempt }) })));
    return { configured: Boolean(process.env.ADO_STAGING_WORKFLOW_TOKEN && process.env.ADO_STAGING_RELEASE_SECRET), releases };
  }

  @Get('projects/:projectId/staging-releases/:pull')
  @UseGuards(SessionGuard)
  async projectStatus(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('pull') pull: string) {
    await this.projects.access(actor.id, projectId);
    const number = Number(input(pull, pullPattern));
    const { rows: [release] } = await this.db.projectQuery<StagingReleaseStatus & Pick<ReleaseRow, 'sha' | 'deploymentAttempt'>>(projectId,
      `SELECT sha, ${statusColumns} FROM staging_releases WHERE $1 = ANY(pulls) AND EXISTS (
         SELECT 1 FROM execution_deliveries d JOIN execution_runs e ON e.id = d.run_id
         JOIN repositories r ON r.id = d.repository_id AND r.project_id = e.project_id
         WHERE e.project_id = $2 AND d.pull_number = $1 AND r.github_repository_id = 1462649547
           AND d.base_branch = 'main' AND d.pull_state = 'merged'
       ) ORDER BY requested_at DESC, sha LIMIT 1`, [number, projectId],
    );
    if (!release) return null;
    const { decidedAt, decidedBy, deploymentRun } = release;
    return { state: await this.reconcile(release), decidedAt, decidedBy, deploymentRun };
  }

  @Post('staging-releases/:sha/decision')
  @UseGuards(SessionGuard)
  @HttpCode(202)
  async decide(@CurrentAccount() actor: Account, @Param('sha') revision: string, @Body() body: unknown) {
    this.auth.requireAdmin(actor);
    const sha = input(revision, shaPattern);
    const { decision, note } = object(body);
    if (decision !== 'approved' && decision !== 'rejected' && decision !== 'retry') throw new BadRequestException('Invalid release decision');
    const reason = typeof note === 'string' ? note.trim() : '';
    if (reason.length > 500 || (decision === 'rejected' && !reason)) throw new BadRequestException('Invalid release decision note');
    const token = process.env.ADO_STAGING_WORKFLOW_TOKEN;
    if (decision !== 'rejected') {
      if (!token || !process.env.ADO_STAGING_RELEASE_SECRET) throw new ServiceUnavailableException('Staging approval is not configured');
      await verifyMain(sha);
    }

    const release = await this.db.transaction(async client => {
      // Recheck the role while recording the decision to serialize with account changes.
      const approver = await client.query(
        "SELECT 1 FROM users WHERE id = $1 AND system_role = 'admin' AND status = 'active' FOR SHARE", [actor.id],
      );
      if (!approver.rowCount) throw new ForbiddenException('Administrator required');
      if (decision === 'retry') {
        const { rows: [existing] } = await client.query("SELECT sha FROM staging_releases WHERE sha = $1 AND state = 'approved'", [sha]);
        return existing;
      }
      const { rows: [updated] } = await client.query(
        `UPDATE staging_releases SET state = $2, decided_by_id = $3, decided_by = $4, decided_at = now(), note = $5
         WHERE sha = $1 AND state = 'pending' RETURNING sha`, [sha, decision, actor.id, actor.name, reason || null],
      );
      return updated;
    });
    if (!release) throw new ConflictException('This staging approval has already moved to another step');
    if (decision === 'rejected') return { dispatched: false };

    const response = await fetch(github + '/actions/workflows/staging-migration.yml/dispatches', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3500),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ ref: 'main', inputs: { sha } }),
    }).catch(() => null);
    // The decision is durable even when dispatch times out. A second dispatch cannot claim the release again.
    return { dispatched: Boolean(response?.ok) };
  }

  @Post('github/staging-releases')
  @HttpCode(204)
  async register(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    authorizeWorkflow(authorization);
    const fields = object(body);
    const sha = input(fields.sha, shaPattern);
    const baseSha = input(fields.baseSha, shaPattern);
    const image = input(fields.image, imagePattern);
    const sourceRun = input(fields.sourceRun, runPattern);
    const { pulls, files } = fields;
    if (sha === baseSha || !Array.isArray(pulls) || pulls.length > 500 ||
      !pulls.every(pull => Number.isInteger(pull) && pull > 0 && pull <= 999999999) ||
      !Array.isArray(files) || !files.length || files.length > stagingMigrationFiles.length ||
      !files.every(file => stagingMigrationFiles.some(path => path === file))) {
      throw new BadRequestException('Invalid release data');
    }
    await this.db.pool.query(
      `INSERT INTO staging_releases (sha, base_sha, image, source_run, pulls, files)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (sha) DO NOTHING`,
      [sha, baseSha, image, sourceRun, [...new Set(pulls)], [...new Set(files)]],
    );
  }

  @Post('github/staging-releases/:sha/claim')
  @HttpCode(200)
  async claim(@Headers('authorization') authorization: string | undefined, @Param('sha') revision: string, @Body() body: unknown) {
    authorizeWorkflow(authorization);
    const sha = input(revision, shaPattern);
    const { run, attempt } = object(body);
    const id = input(run, runPattern);
    const runAttempt = input(attempt, runPattern);
    await verifyMain(sha);
    const { rows: [release] } = await this.db.pool.query<{ image: string; baseSha: string }>(
      `UPDATE staging_releases SET state = 'deploying', deployment_run = $2, deployment_attempt = $3
       WHERE sha = $1 AND (state = 'approved' OR (state = 'deploying' AND deployment_run = $2 AND deployment_attempt = $3))
       RETURNING image, base_sha AS "baseSha"`, [sha, id, runAttempt],
    );
    if (!release) throw new ConflictException('The release is not approved or is already assigned');
    return release;
  }

  @Post('github/staging-releases/:sha/result')
  @HttpCode(204)
  async result(@Headers('authorization') authorization: string | undefined, @Param('sha') revision: string, @Body() body: unknown) {
    authorizeWorkflow(authorization);
    const sha = input(revision, shaPattern);
    const { run, attempt, state } = object(body);
    if (state !== 'succeeded' && state !== 'failed') throw new BadRequestException('Invalid release result');
    const updated = await this.db.pool.query(
      `UPDATE staging_releases SET state = $4 WHERE sha = $1 AND deployment_run = $2 AND deployment_attempt = $3
        AND state IN ('deploying', $4)`, [sha, input(run, runPattern), input(attempt, runPattern), state],
    );
    if (!updated.rowCount) throw new ConflictException('No matching deployment attempt');
  }
}
