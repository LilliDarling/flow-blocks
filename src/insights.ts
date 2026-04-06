import { supabase } from './supabase.js';
import { state } from './state.js';
import { $id, valueToTier, EnergyTier, esc } from './utils.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

type InsightCategory =
  | 'completion_streak'
  | 'energy_block_correlation'
  | 'contextual_nudge'
  | 'dow_skip_pattern';

export interface Insight {
  id: string;
  category: InsightCategory;
  message: string;
  evidenceCount: number;
  weight: number;
  contextual: boolean;
}

interface EventRow {
  id: string;
  type: string;
  entity_id: string | null;
  entity_type: string | null;
  payload: Record<string, unknown>;
  local_dow: number;
  local_hour: number;
  occurred_at: string;
}

// ────────────────────────────────────────────────────────────
// Cache
// ────────────────────────────────────────────────────────────

let cachedEvents: EventRow[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000;

const dismissedInsights = new Set<string>();

// DOW names indexed by JS getDay() convention: 0=Sun..6=Sat
const DOW_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

const MIN_EVIDENCE = 3;

// ────────────────────────────────────────────────────────────
// Data Fetching
// ────────────────────────────────────────────────────────────

async function loadInsightEvents(): Promise<EventRow[]> {
  if (cachedEvents && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedEvents;
  }

  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const { data, error } = await supabase
      .from('events')
      .select('id, type, entity_id, entity_type, payload, local_dow, local_hour, occurred_at')
      .eq('user_id', state.userId)
      .in('type', ['block.completed', 'block.skipped', 'block.expired', 'energy.logged'])
      .gte('occurred_at', since.toISOString())
      .order('occurred_at');

    if (error) {
      console.warn('[insights] failed to load events:', error.message);
      return cachedEvents || [];
    }

    cachedEvents = (data || []) as EventRow[];
    cacheTimestamp = Date.now();
    return cachedEvents;
  } catch (e) {
    console.warn('[insights] load error:', e);
    return cachedEvents || [];
  }
}

/** Invalidate the cache so the next call fetches fresh data. */
export function invalidateInsightCache(): void {
  cachedEvents = null;
  cacheTimestamp = 0;
}

// ────────────────────────────────────────────────────────────
// Detectors
// ────────────────────────────────────────────────────────────

function detectCompletionStreak(events: EventRow[]): Insight[] {
  const completionDates = new Set<string>();
  for (const e of events) {
    if (e.type === 'block.completed') {
      completionDates.add(e.occurred_at.slice(0, 10));
    }
  }

  // Count consecutive days backwards from today
  let streak = 0;
  const d = new Date();
  while (true) {
    const dateStr = d.toISOString().slice(0, 10);
    if (completionDates.has(dateStr)) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }

  if (streak < MIN_EVIDENCE) return [];

  return [{
    id: 'streak:current',
    category: 'completion_streak',
    message: `You've completed blocks ${streak} days in a row. Keep it going!`,
    evidenceCount: streak,
    weight: Math.min(streak / 14, 1),
    contextual: false,
  }];
}

function detectEnergyBlockCorrelation(events: EventRow[]): Insight[] {
  // Group by block_type → energy tier → completed vs skipped
  const stats = new Map<string, Map<EnergyTier, { completed: number; total: number }>>();

  for (const e of events) {
    if (e.type !== 'block.completed' && e.type !== 'block.skipped') continue;
    const blockType = e.payload.block_type as string | undefined;
    const energyVal = e.payload.energy_at_time as number | undefined;
    if (!blockType || energyVal == null) continue;

    const tier = valueToTier(energyVal);
    if (!stats.has(blockType)) stats.set(blockType, new Map());
    const tierMap = stats.get(blockType)!;
    if (!tierMap.has(tier)) tierMap.set(tier, { completed: 0, total: 0 });
    const bucket = tierMap.get(tier)!;
    bucket.total++;
    if (e.type === 'block.completed') bucket.completed++;
  }

  const insights: Insight[] = [];

  for (const [blockType, tierMap] of stats) {
    // Find the tier with the highest completion rate (with enough data)
    let bestTier: EnergyTier | null = null;
    let bestRate = 0;
    let worstRate = 1;
    let totalEvidence = 0;

    for (const [tier, { completed, total }] of tierMap) {
      if (total < MIN_EVIDENCE) continue;
      totalEvidence += total;
      const rate = completed / total;
      if (rate > bestRate) { bestRate = rate; bestTier = tier; }
      if (rate < worstRate) { worstRate = rate; }
    }

    // Only surface if there's a meaningful delta between best and worst
    if (bestTier && totalEvidence >= MIN_EVIDENCE && bestRate - worstRate >= 0.3) {
      const pct = Math.round(bestRate * 100);
      insights.push({
        id: `energy_corr:${blockType}:${bestTier}`,
        category: 'energy_block_correlation',
        message: `${capitalize(blockType)} blocks succeed ${pct}% of the time when your energy is ${bestTier}.`,
        evidenceCount: totalEvidence,
        weight: bestRate - worstRate,
        contextual: false,
      });
    }
  }

  return insights;
}

function detectDowSkipPatterns(events: EventRow[]): Insight[] {
  // Group skips by block_type + local_dow
  const skipsByTypeDow = new Map<string, Map<number, number>>();
  const totalsByType = new Map<string, number>();

  for (const e of events) {
    if (e.type !== 'block.skipped' && e.type !== 'block.expired') continue;
    const blockType = e.payload.block_type as string | undefined;
    if (!blockType || e.local_dow == null) continue;

    if (!skipsByTypeDow.has(blockType)) skipsByTypeDow.set(blockType, new Map());
    const dowMap = skipsByTypeDow.get(blockType)!;
    dowMap.set(e.local_dow, (dowMap.get(e.local_dow) || 0) + 1);
    totalsByType.set(blockType, (totalsByType.get(blockType) || 0) + 1);
  }

  const insights: Insight[] = [];

  for (const [blockType, dowMap] of skipsByTypeDow) {
    const total = totalsByType.get(blockType) || 0;
    if (total < MIN_EVIDENCE) continue;

    const avgPerDay = total / 7;

    for (const [dow, count] of dowMap) {
      // Surface if this day has >= 50% more skips than average
      if (count >= MIN_EVIDENCE && count >= avgPerDay * 1.5) {
        insights.push({
          id: `dow_skip:${blockType}:${dow}`,
          category: 'dow_skip_pattern',
          message: `You tend to skip ${blockType} blocks on ${DOW_NAMES[dow]}. Worth adjusting your schedule?`,
          evidenceCount: count,
          weight: count / total,
          contextual: false,
        });
      }
    }
  }

  return insights;
}

function detectContextualNudge(events: EventRow[]): Insight[] {
  const energy = state.energy;
  const tier = valueToTier(energy);

  // Check: at current energy, which block types have low completion rates?
  const stats = new Map<string, { completed: number; total: number }>();

  for (const e of events) {
    if (e.type !== 'block.completed' && e.type !== 'block.skipped') continue;
    const blockType = e.payload.block_type as string | undefined;
    const energyVal = e.payload.energy_at_time as number | undefined;
    if (!blockType || energyVal == null) continue;
    if (valueToTier(energyVal) !== tier) continue;

    if (!stats.has(blockType)) stats.set(blockType, { completed: 0, total: 0 });
    const s = stats.get(blockType)!;
    s.total++;
    if (e.type === 'block.completed') s.completed++;
  }

  const insights: Insight[] = [];

  for (const [blockType, { completed, total }] of stats) {
    if (total < MIN_EVIDENCE) continue;
    const skipRate = 1 - completed / total;
    if (skipRate >= 0.5) {
      const pct = Math.round(skipRate * 100);
      insights.push({
        id: `nudge:${blockType}:${tier}`,
        category: 'contextual_nudge',
        message: `Your energy is ${tier} right now — you skip ${blockType} blocks ${pct}% of the time at this level. Maybe swap for something lighter?`,
        evidenceCount: total,
        weight: skipRate,
        contextual: true,
      });
    }
  }

  return insights;
}

// ────────────────────────────────────────────────────────────
// Compute & Write
// ────────────────────────────────────────────────────────────

function computeAllInsights(events: EventRow[]): Insight[] {
  return [
    ...detectCompletionStreak(events),
    ...detectEnergyBlockCorrelation(events),
    ...detectDowSkipPatterns(events),
    ...detectContextualNudge(events),
  ].sort((a, b) => b.weight - a.weight);
}

const VALID_NODE = /^[a-z0-9_:]+$/;

async function writeKnowledgeEdges(insights: Insight[]): Promise<void> {
  if (!state.userId) return;

  const rows = insights
    .filter(i => !i.contextual && i.evidenceCount >= MIN_EVIDENCE)
    .map(i => {
      const [source, target] = edgeFromInsight(i);
      return { source, target, weight: i.weight, evidence_count: i.evidenceCount };
    })
    .filter(r => VALID_NODE.test(r.source) && VALID_NODE.test(r.target))
    .map(r => ({
      user_id: state.userId,
      source_node: r.source,
      target_node: r.target,
      weight: r.weight,
      evidence_count: r.evidence_count,
      last_reinforced_at: new Date().toISOString(),
    }));

  if (rows.length === 0) return;

  try {
    const { error } = await supabase
      .from('knowledge_edges')
      .upsert(rows, { onConflict: 'user_id,source_node,target_node' });
    if (error) console.warn('[insights] edge write failed:', error.message);
  } catch (e) {
    console.warn('[insights] edge write error:', e);
  }
}

function edgeFromInsight(insight: Insight): [string, string] {
  const parts = insight.id.split(':');
  switch (insight.category) {
    case 'completion_streak':
      return ['streak:current', `days:${parts[1]}`];
    case 'energy_block_correlation':
      return [`energy:${parts[2]}`, `complete:${parts[1]}`];
    case 'dow_skip_pattern':
      return [`dow:${parts[2]}`, `skip:${parts[1]}`];
    case 'contextual_nudge':
      return [`energy:${parts[2]}`, `skip:${parts[1]}`];
    default:
      return [insight.id, 'unknown'];
  }
}

// ────────────────────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────────────────────

/** Render contextual insights on the day view (0-2 cards). */
export async function renderDayInsights(): Promise<void> {
  const container = $id('dayInsights');
  if (!container) return;

  const events = await loadInsightEvents();
  const contextual = detectContextualNudge(events)
    .filter(i => !dismissedInsights.has(i.id))
    .slice(0, 2);

  // Also show streak if active
  const streak = detectCompletionStreak(events)
    .filter(i => !dismissedInsights.has(i.id));

  const all = [...streak, ...contextual];

  if (all.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = all.map(i => `
    <div class="insight-card ${i.contextual ? 'insight-nudge' : 'insight-positive'}">
      <span class="insight-text">${esc(i.message)}</span>
      <button class="insight-dismiss" data-insight-id="${esc(i.id)}">×</button>
    </div>
  `).join('');
}

/** Render pattern insights on the energy tab. */
export async function renderPatternInsights(): Promise<void> {
  const container = $id('patternInsights');
  if (!container) return;

  const events = await loadInsightEvents();
  const insights = computeAllInsights(events)
    .filter(i => !i.contextual && !dismissedInsights.has(i.id));

  // Write edges in background (errors handled internally)
  void writeKnowledgeEdges(insights);

  if (insights.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <h3 class="pattern-insights-title">Patterns</h3>
    ${insights.map(i => `
      <div class="insight-card insight-pattern">
        <span class="insight-text">${esc(i.message)}</span>
        <span class="insight-evidence">${i.evidenceCount} data points</span>
      </div>
    `).join('')}
  `;
}

/** Initialize dismiss handler (call once). */
export function initInsightEvents(): void {
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.insight-dismiss') as HTMLElement | null;
    if (!btn) return;
    const id = btn.dataset.insightId;
    if (id) {
      dismissedInsights.add(id);
      renderDayInsights();
    }
  });
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
