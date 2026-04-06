import { state } from './state.js';
import { $id, EnergyLogRow, valueToTier, EnergyTier } from './utils.js';

const TIER_LABELS: Record<EnergyTier, string> = { low: 'Low', med: 'Med', high: 'High' };
const TIER_HEIGHT: Record<EnergyTier, number> = { low: 30, med: 60, high: 95 };

interface HourBucket {
  hour: number;
  dominant: EnergyTier;
  counts: Record<EnergyTier, number>;
  total: number;
}

function bucketByHour(logs: EnergyLogRow[]): HourBucket[] {
  const data: Record<number, Record<EnergyTier, number>> = {};
  for (const log of logs) {
    const h = new Date(log.logged_at).getHours();
    const tier = valueToTier(log.value);
    if (!data[h]) data[h] = { low: 0, med: 0, high: 0 };
    data[h][tier]++;
  }
  return Object.entries(data)
    .map(([h, counts]) => {
      const total = counts.low + counts.med + counts.high;
      const dominant: EnergyTier =
        counts.high >= counts.med && counts.high >= counts.low ? 'high' :
        counts.med >= counts.low ? 'med' : 'low';
      return { hour: +h, dominant, counts, total };
    })
    .sort((a, b) => a.hour - b.hour);
}

function fmtHour(h: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}${ampm}`;
}

function barColor(tier: EnergyTier): string {
  if (tier === 'low') return 'var(--danger)';
  if (tier === 'med') return 'var(--steady)';
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

  chart.innerHTML = `
    <div class="energy-bar-chart">
      ${buckets.map(b => {
        const pct = TIER_HEIGHT[b.dominant];
        return `<div class="energy-bar-col">
          <div class="energy-bar-value">${TIER_LABELS[b.dominant]}</div>
          <div class="energy-bar" style="height:${pct}%;background:${barColor(b.dominant)}"></div>
          <div class="energy-bar-label">${fmtHour(b.hour)}</div>
        </div>`;
      }).join('')}
    </div>`;

  // Generate insights
  const peakBuckets = buckets.filter(b => b.dominant === 'high');
  const lowBuckets = buckets.filter(b => b.dominant === 'low');

  // Overall dominant tier
  const totals: Record<EnergyTier, number> = { low: 0, med: 0, high: 0 };
  for (const log of logs) totals[valueToTier(log.value)]++;
  const overallTier: EnergyTier =
    totals.high >= totals.med && totals.high >= totals.low ? 'high' :
    totals.med >= totals.low ? 'med' : 'low';

  const insightItems: string[] = [];
  if (peakBuckets.length > 0) {
    const times = peakBuckets.map(b => `<strong>${fmtHour(b.hour)}</strong>`).join(', ');
    insightItems.push(`You tend to feel high energy around ${times} — great time for push or flow blocks.`);
  }
  if (lowBuckets.length > 0) {
    const times = lowBuckets.map(b => `<strong>${fmtHour(b.hour)}</strong>`).join(', ');
    insightItems.push(`Energy dips around ${times} — good slot for drift or rest.`);
  }
  insightItems.push(`Most common energy level: <strong>${TIER_LABELS[overallTier]}</strong> across ${logs.length} check-ins.`);

  insights.innerHTML = insightItems.map(i => `<div class="energy-insight">${i}</div>`).join('');
}
