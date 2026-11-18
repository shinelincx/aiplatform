export const maxPatchBytes = 16 * 1024 * 1024;

export interface PatchArtifact {
  sha256: string;
  size: number;
}

export interface ExecutionDelivery {
  state: 'queued' | 'publishing' | 'published' | 'failed';
  branch: string;
  baseBranch: string;
  pullNumber: number | null;
  pullUrl: string | null;
  pullState: 'open' | 'closed' | 'merged' | 'changed' | null;
  error: string | null;
}
