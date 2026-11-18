import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canRepair, isWorkerId, maxPatchBytes, parseCheckPlan, type ExecutionOffer, type VerificationReport,
  type WorkerRecovery } from '@ado/shared';
import { configureExecution, executeCodex } from './codex-execution';

type Runtime = NonNullable<Awaited<ReturnType<typeof configureExecution>>>;
type Pending = { kind: string; payload: object };
type Checkpoint = { id: string; archivePatch: boolean; checksRequired: boolean; events: Pending[] };
type Job = {
  checkpoint: Checkpoint;
  signal: AbortController;
  lease: ReturnType<typeof setTimeout>;
  cursor: number;
  completed: boolean;
  recovered: boolean;
  remoteDone: boolean;
};

function isCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<Checkpoint>;
  return isWorkerId(record.id) && typeof record.archivePatch === 'boolean' && typeof record.checksRequired === 'boolean'
    && Array.isArray(record.events) && record.events.length <= 1000
    && record.events.every((event) => event && typeof event.kind === 'string' && event.payload && typeof event.payload === 'object');
}

function isRecovery(value: unknown): value is WorkerRecovery {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<WorkerRecovery>;
  return ['running', 'cancelling', 'finished', 'unavailable'].includes(record.state ?? '')
    && typeof record.lastSequence === 'number' && Number.isSafeInteger(record.lastSequence) && record.lastSequence >= 0;
}

function isTerminal(event: Pending, checkpoint: Checkpoint) {
  return event.kind === 'failed' || event.kind === 'cancelled' || (event.kind === 'result' && !checkpoint.checksRequired)
    || (event.kind === 'verification' && !canRepair(event.payload as VerificationReport));
}

function offerInput(value: unknown): ExecutionOffer {
  const offer = value as Partial<ExecutionOffer> | null;
  if (!offer || !isWorkerId(offer.id) || !isWorkerId(offer.projectId) || !isWorkerId(offer.taskId)
    || typeof offer.repository !== 'string' || !/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(offer.repository)
    || offer.repository.endsWith('/.') || offer.repository.endsWith('/..')
    || typeof offer.defaultBranch !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,254}$/.test(offer.defaultBranch)
    || typeof offer.title !== 'string' || typeof offer.description !== 'string'
    || (offer.archivePatch !== undefined && typeof offer.archivePatch !== 'boolean')
    || !Array.isArray(offer.acceptanceCriteria) || !offer.acceptanceCriteria.every((item) => typeof item === 'string')
    || (offer.repositoryToken !== undefined && typeof offer.repositoryToken !== 'string')) {
    throw new Error('Invalid execution offer');
  }
  return { ...offer as ExecutionOffer, checks: parseCheckPlan(offer.checks ?? []) };
}

export class WorkerJobs {
  private active?: Job;
  private readonly checkpointPath: string;

  constructor(private readonly runtime: Runtime,
    workerId: string,
    private readonly upload: (runId: string, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<boolean>,
    private readonly execute = executeCodex) {
    if (!isWorkerId(workerId)) throw new Error('Invalid Worker identity');
    this.checkpointPath = join(runtime.root, `.worker-${workerId}.active.json`);
  }

  get runId() { return this.active?.checkpoint.id ?? null; }

  async load() {
    let raw: string;
    try {
      raw = await readFile(this.checkpointPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const checkpoint: unknown = JSON.parse(raw);
    if (!isCheckpoint(checkpoint)) throw new Error('Invalid local Worker checkpoint');
    this.active = this.job(checkpoint, true);
  }

  async start(input: unknown) {
    if (this.active) throw new Error('Worker already has a running job');
    const offer = offerInput(input);
    const checkpoint = { id: offer.id, archivePatch: offer.archivePatch === true,
      checksRequired: Boolean(offer.checks?.length), events: [] };
    await this.save(checkpoint);
    const job = this.job(checkpoint, false);
    this.active = job;
    const report = async (kind: string, payload: object) => {
      if (job.signal.signal.aborted) return;
      await this.replace(job, [...job.checkpoint.events, { kind, payload }]);
    };
    void this.execute(this.runtime, offer, report, job.signal.signal).catch(() => {
      // The sender will report a failure if the executor stopped without a persisted terminal event.
    }).finally(() => {
      job.completed = true;
    });
  }

  async reconcile(value: unknown) {
    const job = this.active;
    if (!job) return;
    if (!isRecovery(value)) throw new Error('Invalid execution recovery acknowledgement');
    if (value.state === 'finished' || value.state === 'unavailable' || value.lastSequence > job.checkpoint.events.length) {
      job.remoteDone = true;
      this.cancel();
      if (job.completed) await this.finish(job);
      return;
    }
    job.cursor = value.lastSequence;
    this.renew();
    if (value.state === 'cancelling') this.cancel();
  }

  renew() {
    this.active?.lease.refresh();
  }

  cancel() {
    const job = this.active;
    job?.signal.abort();
  }

  async flush(send: (event: { runId: string; sequence: number; kind: string; payload: object }) => Promise<unknown>) {
    const job = this.active;
    if (!job) return;
    if (job.remoteDone) {
      if (job.completed) await this.finish(job);
      return;
    }
    if (job.signal.signal.aborted && !job.completed) return;
    let event = job.checkpoint.events[job.cursor];
    if (job.signal.signal.aborted) {
      event = { kind: 'cancelled', payload: {} };
      await this.replace(job, [...job.checkpoint.events.slice(0, job.cursor), event]);
    } else if (!event) {
      if (!job.completed) return;
      event = { kind: 'failed', payload: { code: job.recovered ? 'worker_restarted' : 'worker_error' } };
      await this.replace(job, [...job.checkpoint.events, event]);
    }
    if (job.checkpoint.archivePatch && event.kind === 'verification' && 'passed' in event.payload && event.payload.passed === true) {
      const attempt = 'attempt' in event.payload ? event.payload.attempt : undefined;
      let bytes: Buffer | null = null;
      if (typeof attempt === 'number' && Number.isInteger(attempt) && attempt > 0) {
        bytes = await readFile(join(this.runtime.root, job.checkpoint.id, `attempt-${attempt}.patch`)).catch(() => null);
      }
      if (job.signal.signal.aborted) return;
      const stored = bytes && bytes.length <= maxPatchBytes
        && await this.upload(job.checkpoint.id, new Uint8Array(bytes), job.signal.signal);
      if (job.signal.signal.aborted) return;
      if (!stored) {
        event = { kind: 'failed', payload: { code: 'artifact_upload_failed' } };
        await this.replace(job, [...job.checkpoint.events.slice(0, job.cursor), event]);
      }
    }
    const reply = await send({ runId: job.checkpoint.id, sequence: job.cursor + 1, ...event });
    if (!reply || typeof reply !== 'object' || !('accepted' in reply) || !('stop' in reply)) {
      throw new Error('Invalid execution acknowledgement');
    }
    if (reply.accepted !== true) {
      this.cancel();
      throw new Error('Execution event was not accepted');
    }
    job.cursor++;
    if (isTerminal(event, job.checkpoint)) job.remoteDone = true;
    else if (reply.stop === true) this.cancel();
    if (job.remoteDone && job.completed) await this.finish(job);
  }

  private job(checkpoint: Checkpoint, recovered: boolean): Job {
    return { checkpoint, signal: new AbortController(), cursor: 0, completed: recovered, recovered, remoteDone: false,
      lease: setTimeout(() => this.cancel(), 32_000).unref() };
  }

  private async replace(job: Job, events: Pending[]) {
    const checkpoint = { ...job.checkpoint, events };
    await this.save(checkpoint);
    job.checkpoint = checkpoint;
  }

  private async save(checkpoint: Checkpoint) {
    const temporary = `${this.checkpointPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(checkpoint), { flag: 'wx', mode: 0o600, flush: true });
      await rename(temporary, this.checkpointPath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async finish(job: Job) {
    const directory = join(this.runtime.root, job.checkpoint.id);
    if (!job.recovered && await lstat(directory).then((entry) => entry.isDirectory(), () => false)) {
      await Promise.all(['checkout', 'source.git'].map((path) =>
        rm(join(directory, path), { recursive: true, force: true }).catch(() => undefined)));
    }
    await rename(this.checkpointPath, join(this.runtime.root, `${job.checkpoint.id}.events.json`));
    clearTimeout(job.lease);
    this.active = undefined;
  }
}
