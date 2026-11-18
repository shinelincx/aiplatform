import { isWorkerId } from '@ado/shared';
import { api } from '../../../../api-client';

export async function GET(_request: Request, context: {
  params: Promise<{ projectId: string; taskId: string; runId: string }>;
}) {
  const { projectId, taskId, runId } = await context.params;
  if (![projectId, taskId, runId].every(isWorkerId)) return new Response(null, { status: 404 });
  const outcome = await api(`/projects/${projectId}/tasks/${taskId}/executions/${runId}/artifact`).catch(() => null);
  if (!outcome?.ok) return new Response(null, { status: outcome?.status ?? 503 });
  return new Response(outcome.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${runId}.patch"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
