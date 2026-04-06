import { supabase } from './supabase.js';
import { state } from './state.js';
import { BlockType, EnergyTier } from './utils.js';

// ────────────────────────────────────────────────────────────
// Event Types
// ────────────────────────────────────────────────────────────

export type EventType =
  | 'block.created'
  | 'block.updated'
  | 'block.deleted'
  | 'block.completed'
  | 'block.skipped'
  | 'block.dismissed'
  | 'block.expired'
  | 'energy.logged'
  | 'done_item.created'
  | 'reminder.created'
  | 'reminder.updated'
  | 'reminder.deleted'
  | 'reminder.completed'
  | 'reminder.uncompleted'
  | 'reminder.skipped'
  | 'reminder.unskipped'
  | 'pomo.session_completed'
  | 'pomo.settings_updated'
  | 'pomo.distraction_logged'
  | 'calendar.connected'
  | 'calendar.disconnected'
  | 'app.session_started'
  | 'app.session_resumed';

export type EntityType = 'block' | 'reminder' | 'pomo' | null;

export type MutationSource =
  | 'modal'
  | 'timeline'
  | 'drag'
  | 'reorder_suggestion'
  | 'calendar_sync'
  | 'calendar_reconcile'
  | 'time_suggestion'
  | 'manual'
  | 'system';

/** A change record for update events: { field: [oldValue, newValue] }. */
export type ChangeSet = Record<string, [unknown, unknown]>;

/** Device context captured at emit time. */
export interface DeviceContext {
  platform: 'pwa' | 'browser';
  online: boolean;
}

// ────────────────────────────────────────────────────────────
// Event Payloads (typed per event type)
// ────────────────────────────────────────────────────────────

export interface EventPayloads {
  'block.created': {
    type: BlockType;
    title: string;
    menu: string[];
    start_time: string;
    duration: number;
    days: number[];
    block_date: string | null;
    linked_event_id?: string | null;
    source: MutationSource;
  };
  'block.updated': {
    changes: ChangeSet;
    source: MutationSource;
  };
  'block.deleted': {
    block_type: BlockType;
    title: string;
    reason: 'user' | 'calendar_reconcile';
  };
  'block.completed': {
    date: string;
    block_type: BlockType;
    title: string;
    completed_at?: string;
    menu_items_done?: string[];
  };
  'block.skipped': {
    date: string;
    block_type: BlockType;
    title: string;
  };
  'block.dismissed': {
    date: string;
    block_type: BlockType;
    title: string;
  };
  'block.expired': {
    date: string;
    block_type: BlockType;
    title: string;
    scheduled_start: string;
  };
  'energy.logged': {
    value: number;
    tier: EnergyTier;
  };
  'done_item.created': {
    text: string;
    time: string;
    source_block_id?: string;
  };
  'reminder.created': {
    name: string;
    time: string;
    days: number[];
    icon: string;
  };
  'reminder.updated': {
    changes: ChangeSet;
    source: MutationSource;
  };
  'reminder.deleted': Record<string, never>;
  'reminder.completed': {
    date: string;
    reminder_name: string;
  };
  'reminder.uncompleted': {
    date: string;
    reminder_name: string;
  };
  'reminder.skipped': {
    date: string;
    reminder_name: string;
  };
  'reminder.unskipped': {
    date: string;
    reminder_name: string;
  };
  'pomo.session_completed': {
    task: string;
    duration: number;
    distractions: number;
  };
  'pomo.settings_updated': {
    changes: ChangeSet;
  };
  'pomo.distraction_logged': {
    task: string;
    session_elapsed_seconds: number;
  };
  'calendar.connected': {
    provider: string;
    display_name: string;
  };
  'calendar.disconnected': {
    provider: string;
  };
  'app.session_started': {
    last_session_at?: string;
  };
  'app.session_resumed': {
    away_duration_seconds: number;
  };
}

/** A typed event. Generic parameter ensures payload matches the event type. */
export interface AppEvent<T extends EventType = EventType> {
  type: T;
  entity_id?: string;
  entity_type?: EntityType;
  payload: EventPayloads[T];
  occurred_at?: string;
}

/** Row shape stored in IndexedDB queue. */
interface QueuedEvent {
  localId?: number;
  user_id: string;
  type: string;
  entity_id: string | null;
  entity_type: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
}

// ────────────────────────────────────────────────────────────
// IndexedDB Queue
// ────────────────────────────────────────────────────────────

const DB_NAME = 'wildbloom-events';
const DB_VERSION = 1;
const STORE_NAME = 'queue';
const SYNC_INTERVAL_MS = 30_000;
const BATCH_SIZE = 20;

let db: IDBDatabase | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;

function openEventDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const idb = request.result;
      if (!idb.objectStoreNames.contains(STORE_NAME)) {
        idb.createObjectStore(STORE_NAME, { keyPath: 'localId', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function enqueue(event: QueuedEvent): void {
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(event);
  } catch (e) {
    console.warn('[events] enqueue failed:', e);
  }
}

async function drainQueue(): Promise<void> {
  if (draining || !db || !state.userId) return;
  draining = true;

  try {
    // Read a batch from IDB
    const events = await new Promise<QueuedEvent[]>((resolve, reject) => {
      const tx = db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll(null, BATCH_SIZE);
      request.onsuccess = () => resolve(request.result as QueuedEvent[]);
      request.onerror = () => reject(request.error);
    });

    if (events.length === 0) {
      draining = false;
      return;
    }

    // Bulk insert into Supabase
    const rows = events.map(e => ({
      user_id: e.user_id,
      type: e.type,
      entity_id: e.entity_id,
      entity_type: e.entity_type,
      payload: e.payload,
      occurred_at: e.occurred_at,
    }));

    const { error } = await supabase.from('events').insert(rows);

    if (!error) {
      // Remove synced events from IDB
      const tx = db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const event of events) {
        if (event.localId != null) store.delete(event.localId);
      }
    } else {
      console.warn('[events] sync failed, will retry:', error.message);
    }
  } catch (e) {
    console.warn('[events] drain error:', e);
  } finally {
    draining = false;
  }
}

// ────────────────────────────────────────────────────────────
// Context Helpers
// ────────────────────────────────────────────────────────────

function getDeviceContext(): DeviceContext {
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return {
    platform: isStandalone ? 'pwa' : 'browser',
    online: navigator.onLine,
  };
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/** Emit a typed event. Writes to local IDB queue, then triggers background sync. */
export function emit<T extends EventType>(event: AppEvent<T>): void {
  if (!state.userId) return;

  // Auto-inject contextual metadata into payload
  const enrichedPayload: Record<string, unknown> = {
    ...event.payload,
    energy_at_time: state.energy,
    device: getDeviceContext(),
  };

  const queued: QueuedEvent = {
    user_id: state.userId,
    type: event.type,
    entity_id: event.entity_id || null,
    entity_type: event.entity_type || null,
    payload: enrichedPayload,
    occurred_at: event.occurred_at || new Date().toISOString(),
  };

  enqueue(queued);

  // Trigger immediate drain (non-blocking)
  drainQueue();
}

/** Initialize the event system. Call once after auth. */
export async function initEvents(): Promise<void> {
  try {
    db = await openEventDB();
    // Drain any leftover events from prior sessions
    drainQueue();
    // Start periodic sync loop
    startSyncLoop();
    // Sweep yesterday's unacted blocks (fire-and-forget)
    sweepExpiredBlocks();
  } catch (e) {
    console.warn('[events] init failed:', e);
  }
}

export function startSyncLoop(): void {
  if (syncTimer) return;
  syncTimer = setInterval(drainQueue, SYNC_INTERVAL_MS);
}

export function stopSyncLoop(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

/** Compute a ChangeSet from two objects. Only includes fields that actually changed. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): ChangeSet {
  const changes: ChangeSet = {};
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    const a = JSON.stringify(before[key]);
    const b = JSON.stringify(after[key]);
    if (a !== b) {
      changes[key] = [before[key], after[key]];
    }
  }
  return changes;
}

// ────────────────────────────────────────────────────────────
// End-of-Day Sweep
// ────────────────────────────────────────────────────────────

const SWEEP_KEY = 'wildbloom-last-sweep';

/** Emit block.expired for yesterday's blocks that had no interaction.
 *  Runs once per calendar day, on first app open. */
async function sweepExpiredBlocks(): Promise<void> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Only run once per day
  if (localStorage.getItem(SWEEP_KEY) === todayStr) return;

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const yesterdayDayIdx = yesterday.getDay() === 0 ? 6 : yesterday.getDay() - 1; // Mon=0

  // Find blocks that were scheduled for yesterday
  const scheduledBlocks = state.blocks.filter(b => {
    if (b.date) return b.date === yesterdayStr;
    return b.days.includes(yesterdayDayIdx);
  });

  if (scheduledBlocks.length === 0) {
    localStorage.setItem(SWEEP_KEY, todayStr);
    return;
  }

  // Query yesterday's completions to find which blocks had interactions
  const interactedIds = new Set<string>();

  // Check recurring block completions for yesterday
  const recurringIds = scheduledBlocks.filter(b => !b.date && b.id).map(b => b.id!);
  if (recurringIds.length > 0) {
    const { data } = await supabase
      .from('block_completions')
      .select('block_id')
      .in('block_id', recurringIds)
      .eq('completion_date', yesterdayStr);
    for (const row of data || []) {
      interactedIds.add((row as { block_id: string }).block_id);
    }
  }

  // One-off blocks: check their status directly (anything other than 'pending' = interacted)
  for (const b of scheduledBlocks) {
    if (b.date && b.id && b.status !== 'pending') {
      interactedIds.add(b.id);
    }
  }

  // Emit block.expired for blocks with no interaction
  const midnight = new Date(yesterday);
  midnight.setHours(23, 59, 59, 0);
  const expiredAt = midnight.toISOString();

  for (const block of scheduledBlocks) {
    if (!block.id || interactedIds.has(block.id)) continue;
    emit({
      type: 'block.expired',
      entity_id: block.id,
      entity_type: 'block',
      payload: {
        date: yesterdayStr,
        block_type: block.type,
        title: block.title,
        scheduled_start: block.start,
      },
      occurred_at: expiredAt,
    });
  }

  localStorage.setItem(SWEEP_KEY, todayStr);
}
