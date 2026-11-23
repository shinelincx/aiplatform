import { agentRoleLabels, workerDiskPressure, type ModelUsageRow, type WorkerReport } from '@ado/shared';

export function formatTokens(value: bigint) {
  return value.toLocaleString('zh-CN');
}

export function tokenTotal(usage: ModelUsageRow[]) {
  return usage.reduce((total, row) => total + BigInt(row.inputTokens) + BigInt(row.outputTokens), 0n);
}

const usageParts = [
  { label: '未缓存输入', tone: 'ice' },
  { label: '缓存输入', tone: 'violet' },
  { label: '输出', tone: 'mint' },
] as const;

export function UsageChart({ usage, limit, compact = false }: { usage: ModelUsageRow[]; limit?: number; compact?: boolean }) {
  const ranked = usage.map((row) => {
    const input = BigInt(row.inputTokens);
    const output = BigInt(row.outputTokens);
    const cached = BigInt(row.cachedInputTokens);
    const cachedPart = cached > input ? input : cached;
    return { row, total: input + output, values: [input - cachedPart, cachedPart, output], input, cached, output };
  }).sort((a, b) => a.total === b.total ? 0 : a.total > b.total ? -1 : 1);
  const largest = ranked[0]?.total ?? 0n;
  if (!ranked.length) return <p className="empty">暂无模型用量</p>;

  return <div className={compact ? 'usage-chart usage-chart--compact' : 'usage-chart'}>
    <ul className="chart-legend" aria-label="用量图例">
      {usageParts.map(({ label, tone }) => <li key={tone} data-tone={tone}><i />{label}</li>)}
    </ul>
    <ol className="usage-chart__rows" aria-label="模型与岗位用量排行" tabIndex={compact ? undefined : 0}>
      {(limit === undefined ? ranked : ranked.slice(0, limit)).map(({ row, total, values, input, cached, output }) => {
        const role = row.role ? agentRoleLabels[row.role] : 'Codex';
        return <li className="usage-chart__row" key={`${row.role}/${row.model}`}>
          <div className="usage-chart__label">
            <strong>{row.model ?? 'Worker 默认模型'}</strong><small>{role}</small>
            <b>{formatTokens(total)}</b>
          </div>
          <div className="chart-track" aria-hidden="true">
            {values.map((value, index) => <i key={usageParts[index].tone} data-tone={usageParts[index].tone}
              style={{ width: largest ? `${Number(value * 10000n / largest) / 100}%` : '0%' }} />)}
          </div>
          {compact ? <span className="sr-only">
            输入 {formatTokens(input)}，缓存 {formatTokens(cached)}，输出 {formatTokens(output)}
          </span> : <div className="usage-chart__values">
            {cached > input ? <span>输入 {formatTokens(input)} · 缓存 {formatTokens(cached)} · 输出 {formatTokens(output)}</span>
              : values.map((value, index) => <span key={usageParts[index].tone} data-tone={usageParts[index].tone}>
              {formatTokens(value)}<span className="sr-only"> {usageParts[index].label}</span>
              </span>)}
            <span className="usage-chart__cost">{row.estimatedUsd === null ? '费用 —' : `US$${row.estimatedUsd.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')}`}</span>
          </div>}
        </li>;
      })}
    </ol>
  </div>;
}

type DistributionPart = { label: string; value: number; tone: string };

export function StatusDistribution({ parts, label }: { parts: DistributionPart[]; label: string }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (!total) return null;
  return <div className="status-chart" role="group" aria-label={label}>
    <div className="chart-track" aria-hidden="true">
      {parts.map((part) => <i key={part.tone} data-tone={part.tone} style={{ width: `${part.value / total * 100}%` }} />)}
    </div>
    <ul className="chart-legend">
      {parts.map(({ label, value, tone }) => <li data-tone={tone} key={tone}><i />{label} <b>{value}</b></li>)}
    </ul>
  </div>;
}

export function isDiskPaused({ status, capabilities }: WorkerReport) {
  return status === 'online' && Boolean(capabilities?.codexVersion && workerDiskPressure(capabilities));
}

export const workerStatusLabels: Record<WorkerReport['status'], string> = {
  unregistered: '待注册', online: '在线', disconnected: '已断开', disabled: '已停用',
};

export function FleetStatus({ workers }: { workers: WorkerReport[] }) {
  const paused = workers.filter(isDiskPaused).length;
  return <StatusDistribution label="Worker 状态分布" parts={[
    { tone: 'mint', label: '在线', value: workers.filter(({ status }) => status === 'online').length - paused },
    { tone: 'amber', label: '磁盘暂停', value: paused },
    { tone: 'rose', label: workerStatusLabels.disconnected, value: workers.filter(({ status }) => status === 'disconnected').length },
    { tone: 'ice', label: workerStatusLabels.unregistered, value: workers.filter(({ status }) => status === 'unregistered').length },
    { tone: 'mute', label: workerStatusLabels.disabled, value: workers.filter(({ status }) => status === 'disabled').length },
  ]} />;
}

function formatGiB(bytes: number) {
  return (bytes / 1024 ** 3).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
}

export function ResourceMeter({ label, value, max, threshold, tone = 'mint', caption }: {
  label: string; value: number; max: number; threshold?: number; tone?: string; caption: string;
}) {
  const percent = (part: number) => max > 0 ? Math.min(100, Math.max(0, part / max * 100)) : 0;
  return <div className="resource-meter" role="group" aria-label={label}>
    <div className="resource-meter__label"><span>{label}</span><b>{caption}</b></div>
    <div className="chart-track" aria-hidden="true">
      <i data-tone={tone} style={{ width: `${percent(value)}%` }} />
      {Boolean(threshold) && <span className="chart-marker" style={{ left: `${percent(threshold ?? 0)}%` }} />}
    </div>
    {Boolean(threshold) && <small>最低 {formatGiB(threshold ?? 0)} GiB</small>}
  </div>;
}

export function WorkerResources({ worker, diskScale }: { worker: WorkerReport; diskScale: number }) {
  const caps = worker.capabilities;
  if (!caps) return null;
  const memoryFree = caps.memoryFreeBytes;
  const usedMemory = Math.min(caps.memoryBytes, Math.max(0, caps.memoryBytes - (memoryFree ?? 0)));

  return <div className="resource-meters">
    {memoryFree !== undefined && caps.memoryBytes > 0 && <ResourceMeter label="内存占用" value={usedMemory} max={caps.memoryBytes}
      caption={`${formatGiB(usedMemory)} / ${formatGiB(caps.memoryBytes)} GiB`} tone="ice" />}
    <ResourceMeter label="可用磁盘" value={caps.diskFreeBytes} max={diskScale} threshold={caps.minFreeDiskBytes}
      caption={`${formatGiB(caps.diskFreeBytes)} GiB`} tone={workerDiskPressure(caps) ? 'amber' : 'mint'} />
  </div>;
}
