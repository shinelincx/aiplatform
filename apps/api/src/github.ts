import {
  BadGatewayException, BadRequestException, Body, ConflictException, Controller, Get, Inject,
  Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { sign } from 'node:crypto';
import { parseCheckPlan, type Account, type GitHubInstallation, type GitHubRepository, type RepositoryBinding } from '@ado/shared';
import { AuthService, CurrentAccount, SessionGuard } from './auth';
import { Database, isUniqueViolation } from './database';
import { objectInput, textInput } from './input';
import { ProjectsService } from './projects';

interface InstallationResponse {
  id: number;
  account: { login: string } | null;
  suspended_at: string | null;
}

interface RepositoryResponse {
  id: number;
  owner: { login: string };
  name: string;
  html_url: string;
  default_branch: string;
  archived: boolean;
  disabled: boolean;
}

interface PullResponse {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  updated_at: string;
  head: { ref: string; sha: string };
  base: { ref: string; repo?: { id: number } };
}

function externalId(value: unknown) {
  const id = typeof value === 'string' ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new BadRequestException('Invalid GitHub ID');
  }
  return id;
}

@Injectable()
export class GitHubApp {
  get configured() {
    return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
  }

  private appJwt() {
    const appId = process.env.GITHUB_APP_ID;
    const key = process.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !key) throw new ServiceUnavailableException('GitHub App is not configured');
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const claims = [
      encode({ alg: 'RS256', typ: 'JWT' }),
      encode({ iss: appId, iat: now - 60, exp: now + 540 }),
    ].join('.');
    try {
      const signature = sign('RSA-SHA256', Buffer.from(claims), key.replaceAll('\\n', '\n')).toString('base64url');
      return `${claims}.${signature}`;
    } catch {
      throw new ServiceUnavailableException('GitHub App private key is invalid');
    }
  }

  private async request<T>(path: string, token: string, body?: object) {
    const response = await fetch(`https://api.github.com${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (response?.status === 404) throw new NotFoundException('GitHub resource is unavailable to the App');
    if (!response?.ok) throw new BadGatewayException('GitHub App request failed');
    return {
      data: await response.json() as T,
      hasNextPage: response.headers.get('link')?.includes('rel="next"') ?? false,
    };
  }

  async installations(): Promise<GitHubInstallation[]> {
    const results: GitHubInstallation[] = [];
    const jwt = this.appJwt();
    for (let page = 1; ; page++) {
      const { data, hasNextPage } = await this.request<InstallationResponse[]>(
        `/app/installations?per_page=100&page=${page}`, jwt,
      );
      for (const item of data) {
        if (item.account && !item.suspended_at) {
          results.push({ id: item.id, account: item.account.login });
        }
      }
      if (!hasNextPage) return results;
    }
  }

  async installationToken(installationId: number, repositoryId?: number) {
    const { data } = await this.request<{ token: string }>(
      `/app/installations/${installationId}/access_tokens`, this.appJwt(),
      repositoryId ? { repository_ids: [repositoryId], permissions: { contents: 'read' } }
        : { permissions: { metadata: 'read' } },
    );
    return data.token;
  }

  async deliveryToken(installationId: number, repositoryId: number) {
    const { data } = await this.request<{ token: string }>(
      `/app/installations/${installationId}/access_tokens`, this.appJwt(),
      { repository_ids: [repositoryId], permissions: { contents: 'write', pull_requests: 'write' } },
    );
    return data.token;
  }

  async readPull(installationId: number, repositoryId: number, repository: string, number: number) {
    const token = await this.installationToken(installationId, repositoryId);
    const repositoryPath = repository.split('/').map(encodeURIComponent).join('/');
    const { data } = await this.request<PullResponse>(`/repos/${repositoryPath}/pulls/${number}`, token);
    if (data?.number !== number || data.base?.repo?.id !== repositoryId || typeof data.merged !== 'boolean') {
      throw new BadGatewayException('GitHub pull request does not match the published repository and number');
    }
    return data;
  }

  async draftPull(token: string, repository: string, branch: string, baseBranch: string,
    commit: string, title: string, body: string) {
    const [owner, name] = repository.split('/');
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`;
    const query = new URLSearchParams({ head: `${owner}:${branch}`, base: baseBranch, state: 'all', per_page: '100' });
    const find = async () => (await this.request<PullResponse[]>(`${endpoint}?${query}`, token)).data
      .find((pr) => pr.head.ref === branch && pr.base.ref === baseBranch);
    let pull = await find();
    if (!pull) {
      try {
        pull = (await this.request<PullResponse>(endpoint, token, { title, body, head: branch, base: baseBranch, draft: true })).data;
      } catch (error) {
        pull = await find();
        if (!pull) throw error;
      }
    }
    if (!Number.isSafeInteger(pull.number) || pull.number < 1 || pull.head.ref !== branch
      || pull.head.sha !== commit || pull.base.ref !== baseBranch
      || !pull.html_url.startsWith(`https://github.com/${repository}/pull/`)) {
      throw new ConflictException('Existing pull request differs from the tested commit');
    }
    return {
      number: pull.number, url: pull.html_url, updatedAt: pull.updated_at,
      state: pull.merged_at ? 'merged' as const : pull.state,
    };
  }

  async repositories(installationId: number): Promise<GitHubRepository[]> {
    const results: GitHubRepository[] = [];
    const token = await this.installationToken(installationId);
    for (let page = 1; ; page++) {
      const { data, hasNextPage } = await this.request<{ repositories: RepositoryResponse[] }>(
        `/installation/repositories?per_page=100&page=${page}`, token,
      );
      for (const repository of data.repositories) {
        if (!repository.archived && !repository.disabled) {
          results.push({
            id: repository.id, fullName: `${repository.owner.login}/${repository.name}`,
            url: repository.html_url, defaultBranch: repository.default_branch,
          });
        }
      }
      if (!hasNextPage) return results;
    }
  }

  async verifyBranch(installationId: number, repository: GitHubRepository, branch: string) {
    const repositoryPath = repository.fullName.split('/').map(encodeURIComponent).join('/');
    const token = await this.installationToken(installationId, repository.id);
    await this.request(`/repos/${repositoryPath}/branches/${encodeURIComponent(branch)}`, token);
  }
}

const columns = `id, github_repository_id::text AS "githubId", owner || '/' || repo_name AS "fullName",
  repository_url AS url, default_branch AS "defaultBranch", installation_id::text AS "installationId",
  check_plan AS checks, auto_draft_pr AS "autoDraftPr"`;

@Controller('projects/:id/repositories')
@UseGuards(SessionGuard)
export class RepositoriesController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(GitHubApp) private readonly github: GitHubApp,
  ) {}

  @Get()
  async list(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string) {
    await this.projects.access(actor.id, id);
    const { rows } = await this.db.pool.query<RepositoryBinding>(
      `SELECT ${columns} FROM repositories WHERE project_id = $1 ORDER BY owner, repo_name`, [id],
    );
    return rows;
  }

  @Get('installations')
  async installations(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string) {
    await this.authorize(actor, id);
    return { configured: this.github.configured, installations: this.github.configured
      ? await this.github.installations() : [] };
  }

  @Get('installations/:installationId')
  async available(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string,
    @Param('installationId') installationId: string) {
    await this.authorize(actor, id);
    return this.github.repositories(externalId(installationId));
  }

  @Post()
  async bind(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.authorize(actor, id);
    const input = objectInput(body);
    const installationId = externalId(input.installationId);
    const repositoryId = externalId(input.repositoryId);
    const candidates = await this.github.repositories(installationId);
    const repository = candidates.find((item) => item.id === repositoryId);
    if (!repository) throw new NotFoundException('Repository not available in this installation');
    const branch = textInput(input.defaultBranch || repository.defaultBranch, 'defaultBranch', 255);
    await this.github.verifyBranch(installationId, repository, branch);
    const [owner, name] = repository.fullName.split('/');
    try {
      return await this.db.transaction(async (client) => {
        await this.projects.access(actor.id, id, { owner: true, active: true }, client);
        const { rows: [binding] } = await client.query<RepositoryBinding>(
          `INSERT INTO repositories (project_id, github_repository_id, owner, repo_name, repository_url, default_branch, installation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (project_id, github_repository_id) DO UPDATE SET owner = EXCLUDED.owner,
             repo_name = EXCLUDED.repo_name, repository_url = EXCLUDED.repository_url,
             default_branch = EXCLUDED.default_branch, installation_id = EXCLUDED.installation_id
           RETURNING ${columns}`,
          [id, repository.id, owner, name, repository.url, branch, installationId],
        );
        await this.projects.audit(client, actor.id, id, 'repository.bound', binding.id);
        return binding;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Repository is already bound to another project');
      throw error;
    }
  }

  @Patch(':repositoryId/checks')
  async checks(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string,
    @Param('repositoryId', ParseUUIDPipe) repositoryId: string, @Body() body: unknown) {
    const input = objectInput(body);
    const autoDraftPr = input.autoDraftPr;
    if (autoDraftPr !== undefined && typeof autoDraftPr !== 'boolean') {
      throw new BadRequestException('Invalid automatic draft PR setting');
    }
    const checks = (() => {
      try { return parseCheckPlan(input.checks); }
      catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid check plan'); }
    })();
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, id, { owner: true, active: true }, client);
      const { rows: [binding] } = await client.query<RepositoryBinding>(
        `UPDATE repositories SET check_plan = $3, auto_draft_pr = COALESCE($4, auto_draft_pr)
         WHERE project_id = $1 AND id = $2 RETURNING ${columns}`,
        [id, repositoryId, JSON.stringify(checks), autoDraftPr ?? null],
      );
      if (!binding) throw new NotFoundException('Repository binding not found');
      await this.projects.audit(client, actor.id, id, 'repository.checks_updated', repositoryId);
      return binding;
    });
  }

  private async authorize(actor: Account, id: string) {
    this.auth.requireAdmin(actor);
    await this.projects.access(actor.id, id, { owner: true, active: true });
  }
}
