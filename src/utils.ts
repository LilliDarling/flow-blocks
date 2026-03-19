export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export const TYPE_LABELS: Record<BlockType, string> = {
  deep: 'Deep Focus',
  light: 'Light Tasks',
  admin: 'Admin',
  recharge: 'Recharge',
  flex: 'Flex',
  buffer: 'Buffer',
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
  deep:     [7, 10],
  light:    [4, 7],
  admin:    [2, 5],
  recharge: [1, 4],
  flex:     [1, 10],
  buffer:   [1, 10],
};

/** Suggestion messages keyed by energy tier. */
export function energySuggestion(energy: number): string {
  if (energy <= 3) return 'Low battery — lean into recharge or admin blocks. No shame in a slow start.';
  if (energy <= 6) return 'Moderate energy — light tasks and admin are your sweet spot right now.';
  return 'High energy — great time for deep focus. Ride the wave!';
}

/** Keyword map for auto-suggesting block types from task titles. */
/** Suggested menu items per block type — things that match the energy demand of each type. */
export const BLOCK_MENU_SUGGESTIONS: Record<BlockType, string[]> = {
  deep: [
    'Write report or proposal', 'Deep research', 'Coding / programming',
    'Study session', 'Strategic planning', 'Creative writing',
    'Design work', 'Data analysis', 'Build or prototype',
  ],
  light: [
    'Review documents', 'Brainstorm ideas', 'Read articles',
    'Outline next steps', 'Light editing', 'Team check-in',
    'Sketch or wireframe', 'Catch up on Slack/messages', 'Watch training video',
  ],
  admin: [
    'Process emails', 'Pay bills / invoices', 'Schedule appointments',
    'File paperwork', 'Grocery list', 'Update spreadsheets',
    'Tidy desk / workspace', 'Sort notifications', 'Return calls',
  ],
  recharge: [
    'Go for a walk', 'Stretch or yoga', 'Workout / gym',
    'Meditate', 'Cook or bake', 'Craft or draw',
    'Play music', 'Garden', 'Take a power nap',
  ],
  flex: [
    'Whatever feels right', 'Catch up on anything', 'Tackle the smallest task',
    'Side project', 'Learn something new', 'Organize digital files',
  ],
  buffer: [
    'Transition wind-down', 'Quick snack or water', 'Review what\'s next',
    'Bathroom / stretch break', 'Jot down loose thoughts',
  ],
};

export const BLOCK_TYPE_KEYWORDS: Record<string, BlockType> = {
  // Deep focus
  write: 'deep', code: 'deep', coding: 'deep', design: 'deep', research: 'deep',
  study: 'deep', plan: 'deep', planning: 'deep', analyze: 'deep', develop: 'deep',
  program: 'deep', programming: 'deep', essay: 'deep', report: 'deep', thesis: 'deep',
  // Light tasks
  read: 'light', review: 'light', brainstorm: 'light', sketch: 'light',
  meeting: 'light', call: 'light', chat: 'light', discuss: 'light',
  edit: 'light', proofread: 'light', outline: 'light',
  // Admin
  email: 'admin', emails: 'admin', invoice: 'admin', expense: 'admin', bill: 'admin',
  clean: 'admin', organize: 'admin', errands: 'admin', laundry: 'admin',
  dishes: 'admin', grocery: 'admin', groceries: 'admin', file: 'admin',
  paperwork: 'admin', appointment: 'admin', schedule: 'admin',
  // Recharge
  workout: 'recharge', exercise: 'recharge', gym: 'recharge', walk: 'recharge',
  yoga: 'recharge', stretch: 'recharge', meditate: 'recharge', meditation: 'recharge',
  nap: 'recharge', rest: 'recharge', break: 'recharge', craft: 'recharge',
  crafting: 'recharge', draw: 'recharge', drawing: 'recharge', paint: 'recharge',
  painting: 'recharge', music: 'recharge', play: 'recharge', game: 'recharge',
  garden: 'recharge', gardening: 'recharge', cook: 'recharge', cooking: 'recharge',
  bake: 'recharge', baking: 'recharge',
};

export type BlockType = 'deep' | 'light' | 'admin' | 'recharge' | 'flex' | 'buffer';
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
