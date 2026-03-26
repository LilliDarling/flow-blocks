export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export const TYPE_LABELS: Record<BlockType, string> = {
  push: 'Push',
  flow: 'Flow',
  steady: 'Steady',
  growth: 'Growth',
  drift: 'Drift',
  rest: 'Rest',
  buffer: 'Buffer',
};

/** Brief descriptions shown in the block type picker. */
export const TYPE_DESCRIPTIONS: Record<BlockType, string> = {
  push: 'Takes real effort to start or sustain',
  flow: 'You get absorbed — time disappears',
  steady: 'Engaged but sustainable, you can keep going',
  growth: 'Investing in yourself — learning, reflecting',
  drift: 'Autopilot-friendly, needs doing but not much from you',
  rest: 'Actively restores you — not just "not working"',
  buffer: 'Transition time between blocks',
};

export type EnergyTier = 'low' | 'med' | 'high';

/** Map tiers to numeric values for storage (compatible with existing energy_logs). */
export const ENERGY_TIER_VALUE: Record<EnergyTier, number> = { low: 2, med: 5, high: 8 };

/** Map a numeric value back to the nearest tier. */
export function valueToTier(v: number): EnergyTier {
  if (v <= 3) return 'low';
  if (v <= 6) return 'med';
  return 'high';
}

/** Energy ranges where each block type is a good fit: [min, max] inclusive (1-10 scale). */
export const ENERGY_FIT: Record<BlockType, [number, number]> = {
  push:    [7, 10],
  flow:    [5, 9],
  steady:  [4, 7],
  growth:  [3, 7],
  drift:   [1, 5],
  rest:    [1, 4],
  buffer:  [1, 10],
};

/** Suggestion messages keyed by energy tier. */
export function energySuggestion(energy: number): string {
  if (energy <= 3) return 'Low energy — rest or drift blocks are your friend right now. Be gentle.';
  if (energy <= 6) return 'Moderate energy — steady, growth, or flow blocks are your sweet spot.';
  return 'High energy — great time to push. Ride the wave!';
}

/** Suggested menu items per block type — things that match the energy demand of each type. */
export const BLOCK_MENU_SUGGESTIONS: Record<BlockType, string[]> = {
  push: [
    'Hard workout or gym', 'Deep research', 'Difficult conversation',
    'Strategic planning', 'Big creative project', 'Tackle dreaded task',
    'Intense studying', 'Build or prototype', 'Deep cleaning',
  ],
  flow: [
    'Creative writing', 'Crafting or drawing', 'Coding when it clicks',
    'Gardening', 'Playing music', 'Design work',
    'Cooking something new', 'Building something', 'Photography',
  ],
  steady: [
    'Meetings', 'Review documents', 'Team check-ins',
    'Meal prep', 'Light editing', 'Errands',
    'Catch up on messages', 'Moderate exercise', 'House projects',
  ],
  growth: [
    'Journaling', 'Therapy or coaching', 'Read a book',
    'Online course or learning', 'Meditation practice', 'Self-reflection',
    'Skill building', 'Listen to a podcast', 'Plan your goals',
  ],
  drift: [
    'Process emails', 'Sort notifications', 'Fold laundry',
    'Grocery list', 'Water plants', 'Tidy up',
    'File paperwork', 'Update a spreadsheet', 'Scroll-free phone cleanup',
  ],
  rest: [
    'Go for a walk', 'Take a nap', 'Sit outside',
    'Gentle stretching', 'Watch something comforting', 'Snack and rehydrate',
    'Breathwork', 'Do nothing on purpose', 'Pet an animal',
  ],
  buffer: [
    'Transition wind-down', 'Quick snack or water', 'Review what\'s next',
    'Bathroom / stretch break', 'Jot down loose thoughts',
  ],
};

export const BLOCK_TYPE_KEYWORDS: Record<string, BlockType> = {
  // Push — high effort, hard to start
  workout: 'push', gym: 'push', research: 'push', thesis: 'push',
  study: 'push', plan: 'push', planning: 'push', analyze: 'push',
  tackle: 'push', deadline: 'push', deep: 'push', intense: 'push',
  // Flow — absorbing, creative
  write: 'push', code: 'push', coding: 'push', design: 'flow',
  craft: 'flow', crafting: 'flow', draw: 'flow', drawing: 'flow',
  paint: 'flow', painting: 'flow', music: 'flow', play: 'flow',
  garden: 'flow', gardening: 'flow', cook: 'flow', cooking: 'flow',
  bake: 'flow', baking: 'flow', create: 'flow', build: 'flow',
  // Steady — engaged but sustainable
  meeting: 'steady', call: 'steady', chat: 'steady', discuss: 'steady',
  review: 'steady', edit: 'steady', proofread: 'steady', errands: 'steady',
  read: 'steady', outline: 'steady', prep: 'steady',
  // Growth — self-investment
  journal: 'growth', journaling: 'growth', therapy: 'growth', learn: 'growth',
  course: 'growth', meditate: 'growth', meditation: 'growth', reflect: 'growth',
  podcast: 'growth', book: 'growth', goals: 'growth', practice: 'growth',
  // Drift — autopilot
  email: 'drift', emails: 'drift', invoice: 'drift', expense: 'drift', bill: 'drift',
  organize: 'drift', laundry: 'drift', dishes: 'drift', grocery: 'drift',
  groceries: 'drift', file: 'drift', paperwork: 'drift', tidy: 'drift',
  clean: 'drift', sort: 'drift', schedule: 'drift', appointment: 'drift',
  // Rest — restorative
  nap: 'rest', rest: 'rest', break: 'rest', walk: 'rest',
  stretch: 'rest', yoga: 'rest', relax: 'rest', breathe: 'rest',
  nothing: 'rest', recharge: 'rest',
};

export type BlockType = 'push' | 'flow' | 'steady' | 'growth' | 'drift' | 'rest' | 'buffer';
export type BlockStatus = 'pending' | 'done' | 'skipped' | 'dismissed';

export interface FlowBlock {
  id?: string;
  type: BlockType;
  title: string;
  menu: string[];
  start: string;
  duration: number;
  days: number[];
  date: string | null; // "YYYY-MM-DD" for one-off, null for recurring
  status: BlockStatus;
  created_at?: string; // ISO timestamp from DB
  linked_event_id?: string | null; // calendar event ID this buffer is linked to
}

export interface DoneItem {
  id?: string;
  text: string;
  time: string;
}

export type PomoMode = 'focus' | 'short' | 'long';

export interface PomoSettings {
  focus: number;
  short: number;
  long: number;
  longAfter: number;
}

// DB row types for Supabase
export interface BlockRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  menu: string[];
  start_time: string;
  duration: number;
  days: number[];
  block_date: string | null;
  status: string;
  created_at: string;
  linked_event_id: string | null;
}

export interface CompletionRow {
  id: string;
  block_id: string;
  completion_date: string;
  status: string;
}

export interface EnergyLogRow {
  id: string;
  user_id: string;
  value: number;
  logged_at: string;
}

export interface DoneItemRow {
  id: string;
  user_id: string;
  text: string;
  time: string;
  created_at: string;
}

export interface PomoSettingsRow {
  user_id: string;
  completed_pomos: number;
  focus_minutes: number;
  streak: number;
  focus_duration: number;
  short_duration: number;
  long_duration: number;
  long_after: number;
  sound_on: boolean;
}

export interface Reminder {
  id?: string;
  name: string;
  time: string;        // "HH:MM" — when the reminder should fire
  days: number[];      // [0=Mon...6=Sun] for recurring days
  icon: string;        // emoji icon for quick visual identification
  created_at?: string;
}

export interface ReminderRow {
  id: string;
  user_id: string;
  name: string;
  reminder_time: string;
  days: number[];
  icon: string;
  created_at: string;
}

export interface ReminderCompletionRow {
  id: string;
  reminder_id: string;
  completion_date: string;
  completed_at: string;
}

/** A suggestion to reschedule a reminder based on actual completion patterns. */
export interface ReminderTimeSuggestion {
  reminderId: string;
  reminderName: string;
  reminderIcon: string;
  scheduledTime: string;   // "HH:MM" — current scheduled time
  suggestedTime: string;   // "HH:MM" — optimal time based on 7-day data
  avgCompletionTime: string; // "HH:MM" — average actual completion time
  dataPoints: number;       // how many completions the suggestion is based on
}

export function reminderFromRow(row: ReminderRow): Reminder {
  return {
    id: row.id,
    name: row.name,
    time: row.reminder_time.slice(0, 5),
    days: row.days || [],
    icon: row.icon || '',
    created_at: row.created_at,
  };
}

export interface PomoSession {
  id?: string;
  task: string;
  duration: number;
  distractions: number;
  completed_at: string;
}

export interface PomoSessionRow {
  id: string;
  user_id: string;
  task: string;
  duration: number;
  distractions: number;
  completed_at: string;
  created_at: string;
}

export function blockFromRow(row: BlockRow): FlowBlock {
  return {
    id: row.id,
    type: row.type as BlockType,
    title: row.title,
    menu: row.menu || [],
    start: row.start_time.slice(0, 5), // "HH:MM:SS" -> "HH:MM"
    duration: row.duration,
    days: row.days || [],
    date: row.block_date,
    status: row.status as BlockStatus,
    created_at: row.created_at,
    linked_event_id: row.linked_event_id || null,
  };
}

export function getTodayDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`; // local "YYYY-MM-DD"
}

export function doneItemFromRow(row: DoneItemRow): DoneItem {
  return { id: row.id, text: row.text, time: row.time };
}

export function fmtTime(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

export function addMinutes(t: string, mins: number): string {
  const [h, m] = t.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

export function getTodayIndex(): number {
  const day = new Date().getDay();
  return day === 0 ? 6 : day - 1; // Mon=0
}

/** Returns "YYYY-MM-DD" for the given day index (Mon=0..Sun=6) in the current week. */
export function getDateForDayIndex(dayIdx: number): string {
  const today = new Date();
  const todayIdx = getTodayIndex();
  const diff = dayIdx - todayIdx;
  const d = new Date(today);
  d.setDate(d.getDate() + diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function $(selector: string): HTMLElement {
  return document.querySelector(selector) as HTMLElement;
}

export function $id(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}
