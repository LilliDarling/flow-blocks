import { state } from './state.js';
import { $id, EnergyLogRow } from './utils.js';

interface HourBucket {
  hour: number;
  avg: number;
  count: number;
}

function bucketByHour(logs: EnergyLogRow[]): HourBucket[] {
  const sums: Record<number, { total: number; count: number }> = {};
  for (const log of logs) {
    const h = new Date(log.logged_at).getHours();
    if (!sums[h]) sums[h] = { total: 0, count: 0 };
    sums[h].total += log.value;
    sums[h].count++;
  }
  return Object.entries(sums)
    .map(([h, s]) => ({ hour: +h, avg: s.total / s.count, count: s.count }))
    .sort((a, b) => a.hour - b.hour);
}

function fmtHour(h: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}${ampm}`;
}

function barColor(avg: number): string {
  if (avg <= 3) return 'var(--danger)';
  if (avg <= 6) return 'var(--steady)';
  return 'var(--push)';
}

export function renderEnergyAnalytics(): void {
  const chart = $id('energyChart');
  const insights = $id('energyInsights');
  const logs = state.energyLogs;

  if (logs.length < 3) {
    chart.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-dim)">
      <p>Not enough data yet.</p>
      <p style="font-size:0.8rem;margin-top:6px">Use the energy slider on the Today tab — patterns will appear here after a few check-ins.</p>
    </div>`;
    insights.innerHTML = '';
    return;
  }

  const buckets = bucketByHour(logs);
  const maxAvg = Math.max(...buckets.map(b => b.avg), 1);

  chart.innerHTML = `
    <div class="energy-bar-chart">
      ${buckets.map(b => {
        const pct = (b.avg / 10) * 100;
        return `<div class="energy-bar-col">
          <div class="energy-bar-value">${b.avg.toFixed(1)}</div>
          <div class="energy-bar" style="height:${pct}%;background:${barColor(b.avg)}"></div>
          <div class="energy-bar-label">${fmtHour(b.hour)}</div>
        </div>`;
      }).join('')}
    </div>`;

  // Generate insights
  const sorted = [...buckets].sort((a, b) => b.avg - a.avg);
  const peak = sorted[0];
  const low = sorted[sorted.length - 1];
  const overall = logs.reduce((s, l) => s + l.value, 0) / logs.length;

  const insightItems: string[] = [];
  if (peak) insightItems.push(`Your peak energy tends to be around <strong>${fmtHour(peak.hour)}</strong> (avg ${peak.avg.toFixed(1)}) — great time for push or flow blocks.`);
  if (low && low.hour !== peak.hour) insightItems.push(`Energy dips around <strong>${fmtHour(low.hour)}</strong> (avg ${low.avg.toFixed(1)}) — good slot for drift or rest.`);
  insightItems.push(`Overall average: <strong>${overall.toFixed(1)}/10</strong> across ${logs.length} check-ins.`);

  insights.innerHTML = insightItems.map(i => `<div class="energy-insight">${i}</div>`).join('');
}
