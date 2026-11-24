import type { Task, TaskStatus } from '@ado/shared';

export const settingsHref = '/settings';
export const settingsViews = [
  { id: 'account', icon: 'agents', label: '我的账号', adminOnly: false },
  { id: 'projects', icon: 'layers', label: '项目目录', adminOnly: true },
  { id: 'accounts', icon: 'shield', label: '账号管理', adminOnly: true },
  { id: 'staging-releases', icon: 'tasks', label: '系统任务', adminOnly: true },
] as const;
export const themeCookie = 'ado_theme';

export function settingsPath(page: typeof settingsViews[number]['id']) {
  return `${settingsHref}/${page}`;
}

export const workspaceViews = [
  { id: 'overview', icon: 'grid', label: '总览', caption: 'MISSION' },
  { id: 'tasks', icon: 'tasks', label: '任务', caption: 'WORK ITEMS' },
  { id: 'repositories', icon: 'git', label: '仓库', caption: 'REPOSITORIES' },
  { id: 'knowledge', icon: 'layers', label: '项目知识', caption: 'KNOWLEDGE' },
  { id: 'agents', icon: 'agents', label: 'Agent', caption: 'REGISTRY' },
  { id: 'workers', icon: 'workers', label: 'Worker', caption: 'FLEET' },
  { id: 'approvals', icon: 'shield', label: '审批', caption: 'APPROVALS' },
  { id: 'operations', icon: 'chart', label: '用量', caption: 'LEDGER' },
] as const;

export type WorkspaceView = typeof workspaceViews[number]['id'];

export const taskLanes = [
  { id: 'planning', label: '规划', caption: 'PLANNING', tone: 'violet' },
  { id: 'approval', label: '审批', caption: 'APPROVAL', tone: 'amber' },
  { id: 'ready', label: '待派发', caption: 'READY', tone: 'ice' },
  { id: 'running', label: '执行', caption: 'EXECUTION', tone: 'mint' },
  { id: 'testing', label: '测试', caption: 'TESTING', tone: 'teal' },
  { id: 'review', label: '评审', caption: 'REVIEW', tone: 'amber' },
  { id: 'completed', label: '完成', caption: 'COMPLETED', tone: 'mute' },
] as const;

export type TaskLane = typeof taskLanes[number]['id'];

export const laneForStatus: Record<TaskStatus, TaskLane> = {
  CREATED: 'planning', PLANNING: 'planning', WAITING_APPROVAL: 'approval', REJECTED: 'approval',
  READY: 'ready', QUEUED: 'ready', RUNNING: 'running', RETRYING: 'running', FAILED: 'running',
  TIMEOUT: 'running', BLOCKED: 'running', TESTING: 'testing', REVIEW: 'review',
  MERGED: 'completed', COMPLETED: 'completed', CANCELLED: 'completed',
};

export const taskStatusLabels: Record<TaskStatus, string> = {
  CREATED: '草稿', PLANNING: '规划中', WAITING_APPROVAL: '待审批', READY: '待派发', QUEUED: '排队中',
  RUNNING: '执行中', TESTING: '测试中', REVIEW: '待评审', MERGED: '已合并', COMPLETED: '已完成',
  BLOCKED: '已阻塞', FAILED: '失败', TIMEOUT: '超时', CANCELLED: '已取消', REJECTED: '已驳回', RETRYING: '重试中',
};

export const executionFailureLabels: Record<string, string> = {
  source_unavailable: '无法检出仓库', sandbox_rejected: '环境隔离检查未通过',
  revision_source_unavailable: '无法恢复前序补丁，请检查归档完整性和仓库基线',
  codex_failed: 'Codex 执行失败', no_changes: 'Codex 未生成代码变更',
  worker_timeout: 'Worker 执行超时', worker_error: 'Worker 处理失败',
  worker_restarted: 'Worker 重启时执行尚未完成',
  npm_cache_unavailable: '无法准备仓库的 npm 缓存',
  maven_cache_unavailable: '无法准备仓库的 Maven 缓存',
  checks_changed_candidate: '测试改动了待审核补丁', checks_failed: '仓库检查未通过',
  artifact_upload_failed: '补丁归档失败', needs_decisions: '待人工确认',
};

export function taskFailureLabel(task: Pick<Task, 'status' | 'decisions' | 'executionFailure'>) {
  if (task.status !== 'FAILED' && task.status !== 'TIMEOUT') return null;
  const code = task.executionFailure?.code;
  if (code === 'no_changes' && task.decisions?.some(({ answer }) => !answer)) return '未生成变更，计划有待人工确认事项';
  return (code && executionFailureLabels[code]) || (task.status === 'TIMEOUT' ? 'Worker 执行超时' : '执行失败，原因未记录');
}

export function workspaceHref(project: string, section: WorkspaceView = 'overview', params?: Record<string, string>) {
  return `/?${new URLSearchParams({ project, ...(section === 'overview' ? {} : { section }), ...params })}`;
}
