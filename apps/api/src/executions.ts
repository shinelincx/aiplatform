import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Injectable,
  Logger, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards,
  type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  canRepair, canTransitionTask, checkFailureStatuses, independentCheckStatuses, isWorkerId, maxVerificationAttempts,
  parseDecisionQuestions, workerOfflineMs, type Account,
  type CheckFailureReason, type CheckResult,
  type AgentAssignment, type DevelopmentHandoff, type ExecutionEvent, type ExecutionOffer, type ExecutionReview, type ExecutionRun, type ReviewEvidence,
  type Task, type TaskStatus, type VerificationCheck, type VerificationReport, type WorkerRecovery,
} from '@ado/shared';
import { CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { DeliveriesService } from './deliveries';
import { GitHubApp } from './github';
import { objectInput, textInput } from './input';
import { ProjectsService } from './projects';
import { requireQualityGate } from './quality-gate';
import { requireTaskDecisions, runFailure, TasksService } from './tasks';
import { workerCanVerify, workerDiskReady, type WorkerIdentity } from './workers';

const runColumns = `id, status, worker_id AS "workerId", thread_id AS "threadId",
  last_sequence AS "lastSequence", cancel_requested AS "cancelRequested", created_at AS "createdAt",
  finished_at AS "finishedAt", verification_report AS report, requested_worker_id AS "requestedWorkerId",
  developer_assignment->'revision' AS revision, review_evidence AS evidence,
  check_plan AS "checkPlan", independent_checks AS "independentChecks"`;
type ClaimedRun = ExecutionRun & { projectId: string; taskId: string };
type WorkerLease = WorkerIdentity & { connectionId: string };
const failureCodes = ['source_unavailable', 'sandbox_rejected', 'codex_failed', 'no_changes', 'worker_timeout',
  'worker_error', 'checks_changed_candidate', 'artifact_upload_failed', 'worker_restarted', 'npm_cache_unavailable',
  'maven_cache_unavailable', 'revision_source_unavailable', 'needs_decisions'];

function attemptInput(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maxVerificationAttempts) {
    throw new BadRequestException('Invalid verification attempt');
  }
  return value;
}

function requestedWorker(body: unknown) {
  const { workerId } = objectInput(body ?? {});
  if (workerId === undefined || workerId === null) return null;
  if (!isWorkerId(workerId)) throw new BadRequestException('Invalid Worker ID');
  return workerId;
}

function checkResult(value: unknown): CheckResult {
  const { name, status, exitCode, durationMs, reason } = objectInput(value);
  if (status !== 'passed' && status !== 'failed' && status !== 'timed_out' && status !== 'unavailable') {
    throw new BadRequestException('Invalid check status');
  }
  if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 320_000
    || (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255))
    || (status === 'passed') !== (exitCode === 0)
    || (status === 'failed') !== (typeof exitCode === 'number' && exitCode > 0)) {
    throw new BadRequestException('Invalid check result');
  }
  if (reason !== undefined && (typeof reason !== 'string' || !Object.hasOwn(checkFailureStatuses, reason)
    || checkFailureStatuses[reason as CheckFailureReason] !== status)) {
    throw new BadRequestException('Invalid check failure reason');
  }
  return { name: textInput(name, 'check name', 48), status, exitCode, durationMs,
    ...(reason && { reason: reason as CheckFailureReason }) };
}

function tokenUsage(value: unknown) {
  const input = objectInput(value);
  const tokens = (key: string) => {
    const count = input[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new BadRequestException('Invalid usage');
    return count;
  };
  const usage = { inputTokens: tokens('inputTokens'), cachedInputTokens: tokens('cachedInputTokens'), outputTokens: tokens('outputTokens') };
  if (usage.cachedInputTokens > usage.inputTokens) throw new BadRequestException('Invalid cached token count');
  return usage;
}

function executionEvent(body: unknown) {
  const data = objectInput(body);
  const { runId, sequence, kind } = data;
  if (!isWorkerId(runId) || typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1 || sequence > 100_000) {
    throw new BadRequestException('Invalid execution event identity');
  }
  const input = objectInput(data.payload);
  if (kind === 'thread') {
    const threadId = textInput(input.threadId, 'thread ID', 128);
    if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new BadRequestException('Invalid thread ID');
    return { runId, sequence, kind: 'thread' as const, payload: { threadId } };
  }
  if (kind === 'progress') {
    const stage = input.stage;
    if (stage === 'revision') {
      const { previousRunId, patchHash, outcome } = input;
      if (!isWorkerId(previousRunId) || typeof patchHash !== 'string' || !/^[0-9a-f]{64}$/.test(patchHash)
        || (outcome !== 'applied' && outcome !== 'unavailable')) {
        throw new BadRequestException('Invalid revision source event');
      }
      return { runId, sequence, kind: 'progress' as const, payload: { stage, previousRunId, patchHash, outcome } };
    }
    if (stage !== 'checkout' && stage !== 'inference' && stage !== 'collecting' && stage !== 'repair') {
      throw new BadRequestException('Invalid execution stage');
    }
    return { runId, sequence, kind: 'progress' as const, payload: { stage } };
  }
  if (kind === 'turn') {
    const { phase, durationMs } = input;
    if (phase !== 'started' && phase !== 'completed' && phase !== 'failed') throw new BadRequestException('Invalid Codex turn');
    const attempt = attemptInput(input.attempt);
    if (phase === 'started' ? durationMs !== undefined
      : typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new BadRequestException('Invalid Codex turn duration');
    }
    if (input.usage !== undefined && phase !== 'completed') throw new BadRequestException('Expected a completed Codex turn for usage');
    return { runId, sequence, kind: 'turn' as const, payload: { phase, attempt, ...(durationMs !== undefined && { durationMs }),
      ...(input.usage !== undefined && { usage: tokenUsage(input.usage) }) } };
  }
  if (kind === 'item') {
    const { itemType, phase, status, exitCode, fileCount } = input;
    if (typeof itemType !== 'string' || !['agent_message', 'command_execution', 'file_change', 'mcp_tool_call'].includes(itemType)
      || (phase !== 'started' && phase !== 'completed')) throw new BadRequestException('Invalid Codex item');
    if (status !== undefined && (phase !== 'completed' || itemType === 'agent_message'
      || (status !== 'completed' && status !== 'failed'))) throw new BadRequestException('Invalid Codex item status');
    if (exitCode !== undefined && (phase !== 'completed' || itemType !== 'command_execution'
      || typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))) throw new BadRequestException('Invalid Codex command exit code');
    if (fileCount !== undefined && (phase !== 'completed' || itemType !== 'file_change'
      || typeof fileCount !== 'number' || !Number.isSafeInteger(fileCount) || fileCount < 0)) {
      throw new BadRequestException('Invalid Codex file count');
    }
    return { runId, sequence, kind: 'item' as const, payload: { itemType, phase, ...(status && { status }),
      ...(exitCode !== undefined && { exitCode }), ...(fileCount !== undefined && { fileCount }) } };
  }
  if (kind === 'failed') {
    if (typeof input.code !== 'string' || !failureCodes.includes(input.code)) throw new BadRequestException('Invalid error code');
    if (input.code === 'needs_decisions') {
      const decisions = parseDecisionQuestions(input.decisions);
      if (!decisions?.length) throw new BadRequestException('Invalid unresolved decisions');
      return { runId, sequence, kind: 'failed' as const, payload: { code: input.code, decisions } };
    }
    return { runId, sequence, kind: 'failed' as const, payload: { code: input.code } };
  }
  if (kind === 'cancelled') return { runId, sequence, kind: 'cancelled' as const,
    payload: input.usage === undefined ? {} : { usage: tokenUsage(input.usage) } };
  if (kind === 'result') {
    const baseCommit = textInput(input.baseCommit, 'base commit', 40);
    const patchHash = textInput(input.patchHash, 'patch hash', 64);
    if (!/^[0-9a-f]{40}$/.test(baseCommit) || !/^[0-9a-f]{64}$/.test(patchHash)
      || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 100) {
      throw new BadRequestException('Invalid result metadata');
    }
    const files = input.files.map((value) => textInput(value, 'file', 350));
    const usage = tokenUsage(input.usage);
    const attempt = input.attempt === undefined ? undefined : attemptInput(input.attempt);
    return { runId, sequence, kind: 'result' as const, payload: { baseCommit, patchHash, files, usage,
      ...(attempt !== undefined && { attempt }) } };
  }
  if (kind === 'verification') {
    const attempt = attemptInput(input.attempt);
    const patchHash = textInput(input.patchHash, 'patch hash', 64);
    if (!/^[0-9a-f]{64}$/.test(patchHash) || !Array.isArray(input.checks) || !input.checks.length || input.checks.length > 8) {
      throw new BadRequestException('Invalid verification report');
    }
    const checks = input.checks.map(checkResult);
    const payload: VerificationReport = { attempt, patchHash, checks, passed: checks.every(({ status }) => status === 'passed') };
    return { runId, sequence, kind: 'verification' as const, payload };
  }
  throw new BadRequestException('Unsupported execution event');
}

@Injectable()
export class ExecutionsService implements OnModuleInit, OnModuleDestroy {
  private reaper?: ReturnType<typeof setInterval>;
  private readonly log = new Logger(ExecutionsService.name);

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(GitHubApp) private readonly github: GitHubApp,
    @Inject(DeliveriesService) private readonly deliveries: DeliveriesService,
  ) {}

  onModuleInit() {
    this.reaper = setInterval(() => {
      void this.expire().catch(() => this.log.warn('Execution lease sweep failed'));
    }, 5000).unref();
  }

  onModuleDestroy() {
    clearInterval(this.reaper);
  }

  async list(actor: Account, projectId: string, taskId: string) {
    await this.tasks.get(actor, projectId, taskId);
    const { rows } = await this.db.projectQuery<ExecutionRun>(projectId,
      `SELECT ${runColumns}, ${runFailure} AS failure,
         (SELECT jsonb_build_object('decision', e.decision, 'comment', e.comment,
         'reviewer', e.reviewer_name, 'reviewedAt', e.reviewed_at) FROM execution_reviews e WHERE e.run_id = r.id) AS review,
         (SELECT jsonb_build_object('sha256', a.sha256, 'size', a.size) FROM execution_artifacts a
           WHERE a.run_id = r.id AND a.sha256 = COALESCE(r.candidate_hash, r.verification_report->>'patchHash')) AS artifact,
         (SELECT jsonb_build_object('state', q.state, 'patchHash', q.patch_hash, 'partialPatch', q.partial_patch,
           'version', r.qa_assignment->'version', 'model', r.qa_assignment->'model', 'assessment', q.assessment)
           FROM execution_qa q WHERE q.run_id = r.id) AS qa,
         (SELECT jsonb_build_object('state', d.state, 'branch', d.branch, 'baseBranch', d.base_branch,
           'pullNumber', d.pull_number, 'pullUrl', d.pull_url, 'pullState', d.pull_state, 'error', d.error,
           'configured', $3::boolean, 'commitSha', d.commit_sha)
           FROM execution_deliveries d WHERE d.run_id = r.id) AS delivery
       FROM execution_runs r WHERE project_id = $1 AND task_id = $2
       ORDER BY created_at DESC, id DESC LIMIT 20`, [projectId, taskId, this.github.configured],
    );
    return rows;
  }

  async events(actor: Account, projectId: string, taskId: string, runId: string) {
    await this.tasks.get(actor, projectId, taskId);
    const { rows } = await this.db.projectQuery<ExecutionEvent>(projectId,
      `SELECT e.sequence, e.kind, e.payload, e.created_at AS "createdAt"
       FROM execution_events e JOIN execution_runs r ON r.id = e.run_id
       WHERE r.project_id = $1 AND r.task_id = $2 AND r.id = $3 ORDER BY e.sequence`, [projectId, taskId, runId],
    );
    return rows;
  }

  async queue(actor: Account, projectId: string, taskId: string, body?: unknown) {
    const workerId = requestedWorker(body);
    const { revisionOf } = objectInput(body ?? {});
    if (revisionOf != null && !isWorkerId(revisionOf)) throw new BadRequestException('Invalid rejected execution ID');
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const task = await this.tasks.find(projectId, taskId, client);
      const revising = task.status === 'REJECTED';
      if (task.archivedAt || !task.repositoryId || !['READY', 'FAILED', 'TIMEOUT', 'TESTING', 'REJECTED'].includes(task.status)
        || revising !== Boolean(revisionOf)) {
        throw new ConflictException('An approved task and bound repository are required');
      }
      if (!task.acceptanceCriteria.length) throw new ConflictException('Acceptance criteria are required');
      requireTaskDecisions(task);
      const { rows: [prior] } = task.status !== 'READY' || task.decisions?.length ? await client.query<{
        id: string; repositoryId: string; patchHash: string | null; decision: string | null; comment: string | null;
        development: DevelopmentHandoff | null; qa: AgentAssignment | null;
      }>(
        `SELECT r.id, r.repository_id AS "repositoryId", r.verification_report->>'patchHash' AS "patchHash",
           h.decision, h.comment, r.developer_assignment AS development, r.qa_assignment AS qa
         FROM execution_runs r LEFT JOIN execution_reviews h ON h.run_id = r.id
         WHERE r.project_id = $1 AND r.task_id = $2 ORDER BY r.created_at DESC, r.id DESC LIMIT 1`, [projectId, taskId],
      ) : { rows: [] };
      if (revising && (!prior || prior.id !== revisionOf || prior.repositoryId !== task.repositoryId
        || prior.decision !== 'rejected' || !prior.patchHash || !prior.comment)) {
        throw new ConflictException('Only the latest rejected candidate can be sent back for revision');
      }
      if (task.status === 'TESTING') {
        const { rows: [previous] } = await client.query<{ status: string; hasReport: boolean; configured: boolean }>(
          `SELECT r.status, r.verification_report IS NOT NULL AS "hasReport",
             jsonb_array_length(g.check_plan) > 0 AS configured
           FROM execution_runs r JOIN repositories g ON g.project_id = r.project_id AND g.id = $3
           WHERE r.project_id = $1 AND r.task_id = $2 ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
          [projectId, taskId, task.repositoryId],
        );
        if (previous?.status !== 'succeeded' || previous.hasReport || !previous.configured) {
          throw new ConflictException('Configure repository checks to rerun an unverified candidate');
        }
      }
      if (task.status === 'FAILED' || task.status === 'TIMEOUT') {
        await this.move(client, task, 'RETRYING', { actorId: actor.id });
        task.status = 'RETRYING';
      }
      const planned = await this.tasks.plannedDevelopment(client, task);
      const agent = await this.tasks.approvedDeveloper(client, task, planned?.agent);
      const existing = (revising || prior?.development?.revision) ? prior?.development : null;
      const handoff: DevelopmentHandoff = existing ?? { agent, ...(planned && { plan: planned.plan }),
        ...(planned?.requirement && { requirement: planned.requirement }), ...(planned?.knowledge && { knowledge: planned.knowledge }) };
      if (existing && task.status === 'READY') handoff.agent = agent;
      if (task.decisions?.length) {
        handoff.decisions = task.decisions.flatMap(({ question, answer }) => answer ? [{ question, answer }] : []);
      }
      if (revising && prior?.patchHash && prior.comment) {
        handoff.revision = { runId: prior.id, patchHash: prior.patchHash, reason: prior.comment };
      }
      const { rows: [run] } = await client.query<ExecutionRun>(
        `INSERT INTO execution_runs (project_id, task_id, repository_id, check_plan, independent_checks, source_branch,
           developer_assignment, qa_assignment)
         SELECT $1, $2, id, check_plan, independent_checks, default_branch, $4, $5 FROM repositories WHERE project_id = $1 AND id = $3
         RETURNING ${runColumns}, NULL AS review, NULL AS artifact, NULL AS delivery`,
        [projectId, taskId, task.repositoryId, handoff, existing ? prior?.qa ?? null : planned?.qa ?? null],
      );
      if (workerId || handoff.revision) {
        await this.assignWorker(client, projectId, run.id, workerId, Boolean(handoff.revision));
        run.requestedWorkerId = workerId;
      }
      await this.move(client, task, 'QUEUED', { runId: run.id, actorId: actor.id,
        ...(workerId && { requestedWorkerId: workerId }),
        ...(handoff.revision && { revisionOf: handoff.revision.runId, previousPatchHash: handoff.revision.patchHash }),
        developer: handoff.agent.role, developerVersion: handoff.agent.version });
      if (revising) await this.projects.audit(client, actor.id, projectId, 'execution.revision_queued', run.id);
      return run;
    });
  }

  private async assignWorker(client: PoolClient, projectId: string, runId: string, workerId: string | null, revision: boolean) {
    if (workerId || revision) {
      const eligible = await client.query(
        `SELECT 1 FROM workers w
         JOIN worker_projects wp ON wp.worker_id = w.id AND wp.project_id = $1
         JOIN execution_runs r ON r.project_id = wp.project_id AND r.id = $2
         JOIN repositories g ON g.id = r.repository_id
         WHERE ($3::uuid IS NULL OR w.id = $3) AND NOT w.disabled AND w.credential_expires_at > now()
           AND w.capabilities ? 'codexVersion' AND ${workerCanVerify} LIMIT 1`, [projectId, runId, workerId]);
      if (!eligible.rowCount) throw new ConflictException(revision
        ? 'No eligible Worker supports reading revision artifacts' : 'Worker is not eligible for this execution');
    }
    await client.query('UPDATE execution_runs SET requested_worker_id = $2 WHERE id = $1', [runId, workerId]);
  }

  async reassign(actor: Account, projectId: string, taskId: string, runId: string, body: unknown) {
    const workerId = requestedWorker(body);
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const task = await this.tasks.find(projectId, taskId, client);
      const { rows: [run] } = await client.query<Pick<ExecutionRun, 'status' | 'requestedWorkerId' | 'revision'>>(
        `SELECT status, requested_worker_id AS "requestedWorkerId", developer_assignment->'revision' AS revision FROM execution_runs
         WHERE id = $1 AND project_id = $2 AND task_id = $3 FOR UPDATE`, [runId, projectId, taskId]);
      if (!run) throw new NotFoundException('Execution run not found');
      if (task.status !== 'QUEUED' || run.status !== 'queued') throw new ConflictException('Only a queued execution can be reassigned');
      if (run.requestedWorkerId === workerId) return;
      await this.assignWorker(client, projectId, runId, workerId, Boolean(run.revision));
      await this.tasks.event(client, task, 'task.worker_reassigned', { runId, actorId: actor.id, requestedWorkerId: workerId });
      await this.projects.audit(client, actor.id, projectId, 'execution.worker_reassigned', runId);
    });
  }

  async review(actor: Account, projectId: string, taskId: string, runId: string, body: unknown) {
    const input = objectInput(body);
    const { decision } = input;
    if (decision !== 'approved' && decision !== 'rejected') throw new BadRequestException('Invalid review decision');
    const comment = textInput(input.comment ?? '', 'review comment', 1500, true);
    if (decision === 'rejected' && !comment) throw new BadRequestException('Rejection needs a reason');
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const { rows: [run] } = await client.query<ExecutionRun>(
        `SELECT ${runColumns} FROM execution_runs WHERE project_id = $1 AND task_id = $2
         ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`, [projectId, taskId],
      );
      if (!run || run.id !== runId) throw new NotFoundException('Current execution run not found');
      if (decision === 'approved' && run.independentChecks?.length) {
        const { rows: [archive] } = await client.query<{ sha256: string }>(
          'SELECT sha256 FROM execution_artifacts WHERE run_id = $1 AND sha256 = $2', [runId, run.report?.patchHash],
        );
        requireQualityGate(run, archive?.sha256);
      }
      const { rows: [existing] } = await client.query<ExecutionReview>(
        `SELECT decision, comment, reviewer_name AS reviewer, reviewed_at AS "reviewedAt"
         FROM execution_reviews WHERE run_id = $1`, [runId],
      );
      if (existing) {
        if (existing.decision === decision && existing.comment === comment) return existing;
        throw new ConflictException('The execution has already been reviewed');
      }
      const task = await this.tasks.find(projectId, taskId, client);
      if (task.status !== 'REVIEW' || run.status !== 'succeeded' || !run.report?.passed) {
        throw new ConflictException('Only a tested candidate in review can be approved or rejected');
      }
      const { rows: [saved] } = await client.query<ExecutionReview>(
        `INSERT INTO execution_reviews (run_id, reviewer_id, reviewer_name, decision, comment)
         VALUES ($1,$2,$3,$4,$5) RETURNING decision, comment, reviewer_name AS reviewer, reviewed_at AS "reviewedAt"`,
        [runId, actor.id, actor.name, decision, comment],
      );
      await this.tasks.event(client, task, 'task.execution_reviewed', { runId, actorId: actor.id, decision });
      await this.projects.audit(client, actor.id, projectId, 'execution.reviewed', runId);
      if (decision === 'rejected') await this.move(client, task, 'REJECTED', { runId, actorId: actor.id });
      else await this.deliveries.enqueueApproved(client, actor.id, task, runId, true);
      return saved;
    });
  }

  async addEvidence(actor: Account, projectId: string, taskId: string, runId: string, body: unknown) {
    const input = objectInput(body);
    const patchHash = textInput(input.patchHash, 'patch hash', 64);
    if (!/^[0-9a-f]{64}$/.test(patchHash)) throw new BadRequestException('Invalid patch hash');
    const summary = textInput(input.summary, 'review evidence', 2000);
    let check: ReviewEvidence['check'];
    if (input.check !== undefined) {
      const entry = objectInput(input.check);
      const status = independentCheckStatuses.find(item => item === entry.status);
      if (!status || entry.source !== 'archive') {
        throw new BadRequestException('Independent results must describe a check performed on this archive');
      }
      check = { name: textInput(entry.name, 'independent check name', 48), status,
        environment: textInput(entry.environment, 'independent check environment', 200), source: 'archive' };
    }
    const rawUrl = textInput(input.url ?? '', 'evidence URL', 1000, true);
    const url = rawUrl ? URL.parse(rawUrl) : null;
    if (rawUrl && (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password)) {
      throw new BadRequestException('Evidence URL must be an HTTP or HTTPS link');
    }
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const { rows: [run] } = await client.query<ExecutionRun>(
        `SELECT ${runColumns} FROM execution_runs WHERE project_id = $1 AND task_id = $2
         ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`, [projectId, taskId],
      );
      if (!run || run.id !== runId) throw new NotFoundException('Current execution run not found');
      const task = await this.tasks.find(projectId, taskId, client);
      if (task.archivedAt || task.status !== 'REVIEW' || run.status !== 'succeeded'
        || !run.report?.passed || run.report.patchHash !== patchHash) {
        throw new ConflictException('Evidence requires the current tested patch in review');
      }
      const archived = await client.query(
        `SELECT 1 FROM execution_artifacts WHERE run_id = $1 AND sha256 = $2
         AND NOT EXISTS (SELECT 1 FROM execution_reviews WHERE run_id = $1)`, [runId, patchHash]);
      if (!archived.rowCount) throw new ConflictException('Evidence requires an unreviewed archived patch');
      if (check && !run.independentChecks?.some(item => item.name === check.name)) {
        throw new ConflictException('Independent check is not required by this execution');
      }
      const entries = (run.evidence ?? []).filter(item => Boolean(item.check) === Boolean(check));
      if (entries.length >= (check ? 100 : 10)) {
        throw new ConflictException('Evidence entry limit reached');
      }
      const evidence: ReviewEvidence = {
        patchHash, summary, ...(url && { url: url.href }), author: actor.name, recordedAt: new Date().toISOString(),
        ...(check && { check }),
      };
      await client.query('UPDATE execution_runs SET review_evidence = review_evidence || $2::jsonb WHERE id = $1',
        [runId, JSON.stringify([evidence])]);
      await this.tasks.event(client, task, 'task.review_evidence_added', {
        runId, patchHash, actorId: actor.id, ...(check && { check: check.name, status: check.status }),
      });
      await this.projects.audit(client, actor.id, projectId, 'execution.evidence_added', runId);
      return evidence;
    });
  }

  async cancel(actor: Account, projectId: string, taskId: string, runId: string) {
    await this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true }, client);
      const { rows: [run] } = await client.query<ExecutionRun>(
        `SELECT ${runColumns} FROM execution_runs WHERE id = $1 AND project_id = $2 AND task_id = $3 FOR UPDATE`,
        [runId, projectId, taskId],
      );
      if (!run) throw new NotFoundException('Execution run not found');
      if (run.status === 'succeeded') {
        const task = await this.tasks.find(projectId, taskId, client);
        if (task.status !== 'TESTING') return;
        const cancelled = await client.query(
          `UPDATE execution_qa SET state = 'cancelled', lease_id = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE run_id = $1 AND state IN ('queued','running','failed')`, [runId]);
        if (cancelled.rowCount) {
          await this.tasks.event(client, task, 'agent.qa_cancelled', { runId, actorId: actor.id });
          await this.move(client, task, 'CANCELLED', { runId, actorId: actor.id });
        }
        return;
      }
      if (run.cancelRequested || !['queued', 'running'].includes(run.status)) return;
      const task = await this.tasks.find(projectId, taskId, client);
      await client.query(
        `UPDATE execution_runs SET cancel_requested = true,
           status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
         WHERE id = $1`, [runId],
      );
      await this.tasks.event(client, task, 'task.execution_cancel_requested', { runId, actorId: actor.id });
      if (run.status === 'queued') await this.move(client, task, 'CANCELLED', { runId, actorId: actor.id });
    });
  }

  private async lockWorker(client: PoolClient, worker: WorkerLease) {
    const result = await client.query<{ canExecute: boolean; canArchive: boolean; diskReady: boolean }>(
      `SELECT capabilities ? 'codexVersion' AS "canExecute",
         capabilities->'artifactVersion' = '1'::jsonb AS "canArchive", ${workerDiskReady} AS "diskReady"
       FROM workers w
       WHERE id = $1 AND credential_hash = $2 AND connection_id = $3
         AND credential_expires_at > now() AND NOT disabled FOR UPDATE`,
      [worker.workerId, worker.hash, worker.connectionId],
    );
    return result.rows[0];
  }

  async claim(worker: WorkerLease): Promise<ExecutionOffer | null> {
    const claimed = await this.db.transaction(async (client) => {
      const capabilities = await this.lockWorker(client, worker);
      if (!capabilities?.canExecute || !capabilities.diskReady) return null;
      const { rows: [candidate] } = await client.query<{ id: string; project_id: string }>(
        'SELECT * FROM ado_private.worker_candidate($1, $2, $3)', [worker.workerId, worker.hash, worker.connectionId]);
      if (!candidate) return null;
      await this.db.bindProject(client, candidate.project_id);
      const { rows: [offer] } = await client.query<ExecutionOffer & { installationId: string; githubId: string }>(
        `SELECT r.id, r.task_id AS "taskId", r.project_id AS "projectId", t.title, t.description,
           t.acceptance_criteria AS "acceptanceCriteria", g.owner || '/' || g.repo_name AS repository,
           COALESCE(r.source_branch, g.default_branch) AS "defaultBranch", g.installation_id::text AS "installationId",
           g.github_repository_id::text AS "githubId", r.check_plan AS checks, r.developer_assignment AS development
         FROM execution_runs r
         JOIN tasks t ON t.id = r.task_id AND t.status = 'QUEUED'
         JOIN repositories g ON g.id = r.repository_id
         WHERE r.id = $1`, [candidate.id],
      );
      if (!offer) return null;
      offer.archivePatch = capabilities.canArchive === true && Boolean(offer.checks?.length);
      offer.detailedEvents = true;
      offer.turnUsage = true;
      offer.decisionReporting = true;
      await client.query(
        `UPDATE execution_runs SET status = 'running', worker_id = $2, lease_expires_at = now() + ($3 * interval '1 millisecond'),
          archive_patch = $4, source_branch = $5 WHERE id = $1`,
        [offer.id, worker.workerId, workerOfflineMs, offer.archivePatch, offer.defaultBranch],
      );
      const task = await this.tasks.find(offer.projectId, offer.taskId, client);
      await this.move(client, task, 'RUNNING', { runId: offer.id, workerId: worker.workerId });
      return offer;
    });
    if (!claimed) return null;
    const { githubId, installationId, ...offer } = claimed;
    if (this.github.configured) {
      // A scoped read credential is used solely for checkout. Public sources can still clone anonymously.
      offer.repositoryToken = await this.github.installationToken(Number(installationId), Number(githubId)).catch(() => undefined);
    }
    return offer;
  }

  async renew(worker: WorkerLease, runId: string) {
    return this.db.transaction(async (client) => {
      if (!await this.lockWorker(client, worker) || !await this.db.bindWorkerRun(client, worker, runId)) return false;
      const { rows: [run] } = await client.query<{ cancelRequested: boolean }>(
        `UPDATE execution_runs r SET lease_expires_at = now() + ($3 * interval '1 millisecond')
         FROM projects p, worker_projects wp WHERE r.id = $1 AND r.worker_id = $2 AND r.status = 'running'
           AND r.lease_expires_at > now() AND p.id = r.project_id AND p.status = 'active'
           AND wp.project_id = r.project_id AND wp.worker_id = $2
         RETURNING r.cancel_requested AS "cancelRequested"`, [runId, worker.workerId, workerOfflineMs],
      );
      return run ? !run.cancelRequested : false;
    });
  }

  async recover(worker: WorkerLease, runId: string): Promise<WorkerRecovery> {
    return this.db.transaction(async (client) => {
      const unavailable = { state: 'unavailable', lastSequence: 0 } as const;
      if (!await this.lockWorker(client, worker) || !await this.db.bindWorkerRun(client, worker, runId)) return unavailable;
      const { rows: [run] } = await client.query<{
        status: ExecutionRun['status']; lastSequence: number; cancelled: boolean; live: boolean | null;
      }>(
        `SELECT r.status, r.last_sequence AS "lastSequence", r.cancel_requested AS cancelled,
           r.lease_expires_at > now() AS live FROM execution_runs r
         JOIN projects p ON p.id = r.project_id AND p.status = 'active'
         JOIN worker_projects wp ON wp.project_id = r.project_id AND wp.worker_id = r.worker_id
         WHERE r.id = $1 AND r.worker_id = $2 FOR UPDATE OF r`, [runId, worker.workerId]);
      if (!run) return unavailable;
      if (run.status !== 'running') return { state: 'finished', lastSequence: run.lastSequence };
      if (!run.live) return unavailable;
      await client.query(
        "UPDATE execution_runs SET lease_expires_at = now() + ($2 * interval '1 millisecond') WHERE id = $1",
        [runId, workerOfflineMs]);
      return { state: run.cancelled ? 'cancelling' : 'running', lastSequence: run.lastSequence };
    });
  }

  async record(worker: WorkerLease, body: unknown) {
    const event = executionEvent(body);
    return this.db.transaction(async (client) => {
      if (!await this.lockWorker(client, worker) || !await this.db.bindWorkerRun(client, worker, event.runId)) {
        return { stop: true, accepted: false };
      }
      const { rows: [run] } = await client.query<ClaimedRun & {
        current: boolean; checks: VerificationCheck[]; candidateHash: string | null; archivePatch: boolean; requiresQa: boolean;
      }>(
        `SELECT ${runColumns}, r.project_id AS "projectId", r.task_id AS "taskId",
           r.check_plan AS checks, r.candidate_hash AS "candidateHash", r.archive_patch AS "archivePatch",
           r.qa_assignment IS NOT NULL AS "requiresQa",
           r.lease_expires_at > now() AND EXISTS (
             SELECT 1 FROM worker_projects wp JOIN projects p ON p.id = wp.project_id AND p.status = 'active'
             WHERE wp.worker_id = $2 AND wp.project_id = r.project_id
           ) AS current
         FROM execution_runs r WHERE id = $1 AND worker_id = $2 FOR UPDATE`, [event.runId, worker.workerId],
      );
      if (!run) return { stop: true, accepted: false };
      if (event.sequence <= run.lastSequence) {
        const same = await client.query(
          'SELECT 1 FROM execution_events WHERE run_id = $1 AND sequence = $2 AND kind = $3 AND payload = $4',
          [event.runId, event.sequence, event.kind, event.payload],
        );
        if (!same.rowCount) return { stop: true, accepted: false };
        return { accepted: true, stop: run.cancelRequested || (run.status === 'running' && !run.current) };
      }
      if (run.status !== 'running' || !run.current || event.sequence !== run.lastSequence + 1) {
        return { stop: true, accepted: false };
      }
      if (run.cancelRequested && event.kind !== 'cancelled') return { stop: true, accepted: false };
      if (event.kind === 'progress' && event.payload.stage === 'revision'
        && (event.payload.previousRunId !== run.revision?.runId || event.payload.patchHash !== run.revision?.patchHash)) {
        return { stop: true, accepted: false };
      }
      if (event.kind === 'thread' && run.threadId && run.threadId !== event.payload.threadId) {
        return { stop: true, accepted: false };
      }
      if (event.kind === 'result' && (!run.threadId || run.candidateHash
        || ((event.payload.attempt ?? 1) !== (run.report?.attempt ?? 0) + 1)
        || (run.report && !canRepair(run.report)))) return { stop: true, accepted: false };
      if (event.kind === 'verification' && (run.candidateHash !== event.payload.patchHash
        || event.payload.attempt !== (run.report?.attempt ?? 0) + 1 || !run.checks.length
        || run.checks.length !== event.payload.checks.length
        || run.checks.some(({ name }, index) => name !== event.payload.checks[index].name))) {
        return { stop: true, accepted: false };
      }
      if (event.kind === 'verification' && event.payload.passed && (run.archivePatch || run.requiresQa)) {
        const artifact = await client.query('SELECT 1 FROM execution_artifacts WHERE run_id = $1 AND sha256 = $2',
          [run.id, event.payload.patchHash]);
        if (!artifact.rowCount) return { stop: true, accepted: false };
      }
      await client.query(
        'INSERT INTO execution_events (run_id, sequence, kind, payload) VALUES ($1,$2,$3,$4)',
        [event.runId, event.sequence, event.kind, event.payload],
      );
      await client.query(
        'UPDATE execution_runs SET last_sequence = $2, thread_id = coalesce($3, thread_id) WHERE id = $1',
        [event.runId, event.sequence, event.kind === 'thread' ? event.payload.threadId : null],
      );
      if (event.kind === 'result') {
        if (!run.checks.length) await this.finish(client, run, 'succeeded');
        else {
          await client.query('UPDATE execution_runs SET candidate_hash = $2 WHERE id = $1', [run.id, event.payload.patchHash]);
          const task = await this.tasks.find(run.projectId, run.taskId, client);
          if (task.status === 'RUNNING') await this.move(client, task, 'TESTING', { runId: run.id });
        }
      } else if (event.kind === 'verification') {
        await client.query('UPDATE execution_runs SET verification_report = $2, candidate_hash = NULL WHERE id = $1',
          [run.id, event.payload]);
        if (!canRepair(event.payload)) {
          const requiresQa = event.payload.passed && run.requiresQa;
          if (requiresQa) {
            await client.query("INSERT INTO execution_qa (run_id, patch_hash, state) VALUES ($1,$2,'queued')",
              [run.id, event.payload.patchHash]);
            const task = await this.tasks.find(run.projectId, run.taskId, client);
            await this.tasks.event(client, task, 'agent.qa_queued', { runId: run.id, patchHash: event.payload.patchHash });
          }
          await this.finish(client, run, event.payload.passed ? 'succeeded' : 'failed', event.payload.passed, requiresQa);
        }
      } else if (event.kind === 'failed' || event.kind === 'cancelled') {
        await this.finish(client, run, event.kind === 'cancelled' ? 'cancelled'
          : event.payload.code === 'worker_timeout' ? 'timed_out' : 'failed');
      }
      return { stop: false, accepted: true };
    });
  }

  private async expire() {
    for (let index = 0; index < 25; index++) {
      const expired = await this.db.transaction(async (client) => {
        const runId = await this.db.nextProjectJob(client, 'expired_execution');
        if (!runId) return false;
        const { rows: [run] } = await client.query<ClaimedRun>(
          `SELECT ${runColumns}, project_id AS "projectId", task_id AS "taskId" FROM execution_runs WHERE id = $1`, [runId]);
        if (!run) return false;
        await this.finish(client, run, run.cancelRequested ? 'cancelled' : 'timed_out');
        return true;
      });
      if (!expired) break;
    }
  }

  private async finish(client: PoolClient, run: ClaimedRun,
    status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out', verified = false, requiresQa = false) {
    await client.query('UPDATE execution_runs SET status = $2, finished_at = now(), lease_expires_at = NULL WHERE id = $1',
      [run.id, status]);
    if (requiresQa) return;
    const task = await this.tasks.find(run.projectId, run.taskId, client);
    const next = { succeeded: verified ? 'REVIEW' : 'TESTING', failed: 'FAILED', cancelled: 'CANCELLED', timed_out: 'TIMEOUT' } as const;
    await this.move(client, task, next[status], { runId: run.id, workerId: run.workerId });
  }

  private async move(client: PoolClient, task: Task, to: TaskStatus, context: object) {
    if (!canTransitionTask(task.status, to)) throw new ConflictException('Invalid task transition');
    const updated = await client.query(
      `UPDATE tasks SET status = $3, updated_at = now()
       WHERE project_id = $1 AND id = $2 AND status = $4`, [task.projectId, task.id, to, task.status],
    );
    if (!updated.rowCount) throw new ConflictException('Task status changed concurrently');
    await this.tasks.event(client, task, 'task.status_changed', { from: task.status, to, ...context });
  }
}

@Controller('projects/:projectId/tasks/:taskId/executions')
@UseGuards(SessionGuard)
export class ExecutionsController {
  constructor(@Inject(ExecutionsService) private readonly executions: ExecutionsService) {}

  @Get()
  list(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.executions.list(actor, projectId, taskId);
  }

  @Post()
  queue(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string, @Body() body: unknown) {
    return this.executions.queue(actor, projectId, taskId, body);
  }

  @Post(':runId/worker')
  @HttpCode(204)
  reassign(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() body: unknown) {
    return this.executions.reassign(actor, projectId, taskId, runId, body);
  }

  @Get(':runId/events')
  events(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.executions.events(actor, projectId, taskId, runId);
  }

  @Post(':runId/cancel')
  @HttpCode(204)
  cancel(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.executions.cancel(actor, projectId, taskId, runId);
  }

  @Post(':runId/review')
  @HttpCode(200)
  review(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() body: unknown) {
    return this.executions.review(actor, projectId, taskId, runId, body);
  }

  @Post(':runId/evidence')
  addEvidence(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() body: unknown) {
    return this.executions.addEvidence(actor, projectId, taskId, runId, body);
  }
}
