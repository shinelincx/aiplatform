
import { stagingRepository, type StagingReleaseState } from '@ado/shared';

export const stagingReleaseLabels: Record<StagingReleaseState, string> = {
  pending: '待人工发布审批', approved: '已批准 · 等待部署', rejected: '发布已驳回',
  deploying: '部署中', succeeded: '已部署预发布', failed: '预发布部署失败',
};

export function stagingRunUrl(run: string) {
  return 'https://github.com/' + stagingRepository + '/actions/runs/' + run;
}
