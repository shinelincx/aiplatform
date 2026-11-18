import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isWorkerId, maxPatchBytes, parseCheckPlan, type ExecutionOffer } from '@ado/shared';
import { configureExecution, executeCodex } from './codex-execution';

type Runtime = NonNullable<Awaited<ReturnType<typeof configureExecution>>>;
type Pending = { kind: string; payload: object };

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
  private active?: {
    id: string;
    signal: AbortController;
    lease: ReturnType<typeof setTimeout>;
    pending: Pending[];
    sequence: number;
    completed: boolean;
    archivePatch: boolean;
  };

  constructor(private readonly runtime: Runtime,
    private readonly upload: (runId: string, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<boolean>) {}

  get runId() { return this.active?.id ?? null; }

  start(input: unknown) {
    if (this.active) throw new Error('Worker already has a running job');
    const offer = offerInput(input);
    const signal = new AbortController();
    const job = {
      id: offer.id, signal, lease: setTimeout(() => this.cancel(), 32_000),
      pending: [] as Pending[], sequence: 1, completed: false, archivePatch: offer.archivePatch === true,
    };
    this.active = job;
    const report = async (kind: string, payload: object) => {
      if (signal.signal.aborted && kind !== 'cancelled') return;
      await appendFile(join(this.runtime.root, `${offer.id}.events.jsonl`),
        JSON.stringify({ kind, payload }) + '\n', { mode: 0o600 });
      job.pending.push({ kind, payload });
    };
    void executeCodex(this.runtime, offer, report, signal.signal).catch(() => {
      signal.abort();
      job.pending = [];
    }).finally(async () => {
      if (signal.signal.aborted) {
        job.pending = [];
        await report('cancelled', {}).catch(() => {
          job.pending.push({ kind: 'cancelled', payload: {} });
        });
      }
      job.completed = true;
    });
  }

  renew() {
    this.active?.lease.refresh();
  }

  cancel() {
    const job = this.active;
    if (!job || job.signal.signal.aborted) return;
    job.signal.abort();
    if (job.completed) job.pending = [{ kind: 'cancelled', payload: {} }];
  }

  async flush(send: (event: { runId: string; sequence: number; kind: string; payload: object }) => Promise<unknown>) {
    const job = this.active;
    if (!job) return;
    if (job.signal.signal.aborted && !job.completed) return;
    let event = job.pending[0];
    if (job.archivePatch && event?.kind === 'verification' && 'passed' in event.payload && event.payload.passed === true) {
      const attempt = 'attempt' in event.payload ? event.payload.attempt : undefined;
      let bytes: Buffer | null = null;
      if (typeof attempt === 'number' && Number.isInteger(attempt) && attempt > 0) {
        bytes = await readFile(join(this.runtime.root, job.id, `attempt-${attempt}.patch`)).catch(() => null);
      }
      if (job.signal.signal.aborted) return;
      const stored = bytes && bytes.length <= maxPatchBytes && await this.upload(job.id, new Uint8Array(bytes), job.signal.signal);
      if (job.signal.signal.aborted) return;
      if (!stored) {
        event = { kind: 'failed', payload: { code: 'artifact_upload_failed' } };
        job.pending[0] = event;
      }
    }
    if (event) {
      const reply = await send({ runId: job.id, sequence: job.sequence, ...event });
      if (!reply || typeof reply !== 'object' || !('accepted' in reply) || !('stop' in reply)) {
        throw new Error('Invalid execution acknowledgement');
      }
      if (reply.accepted === true) {
        if (job.pending[0] === event) job.pending.shift();
        job.sequence++;
      } else if (event.kind === 'cancelled') {
        this.finish();
        return;
      }
      if (reply.stop === true) this.cancel();
    }
    if (job.completed && job.pending.length === 0) this.finish();
  }

  private finish() {
    clearTimeout(this.active?.lease);
    this.active = undefined;
  }
}
