export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export const TYPE_LABELS: Record<BlockType, string> = {
  deep: 'Deep Focus',
  light: 'Light Tasks',
  admin: 'Admin',
  recharge: 'Recharge',
  flex: 'Flex',
  buffer: 'Buffer',
};

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

export type BlockType = 'deep' | 'light' | 'admin' | 'recharge' | 'flex' | 'buffer';
export type BlockStatus = 'pending' | 'done' | 'skipped';

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
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
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
  return d.toISOString().slice(0, 10);
}

export function $(selector: string): HTMLElement {
  return document.querySelector(selector) as HTMLElement;
}

export function $id(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}
