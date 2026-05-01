import { supabase } from './supabase.js';
import { state } from './state.js';
import { BlockType, EnergyTier, getTodayDate, getDateOffsetFromToday } from './utils.js';

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
    duration_minutes?: number;
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
    duration_minutes?: number;
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
  local_dow: number;
  local_hour: number;
  occurred_at: string;
}

// ────────────────────────────────────────────────────────────
// IndexedDB Queue
// ────────────────────────────────────────────────────────────

const DB_NAME = 'wildbloom-events';
const DB_VERSION = 1;
const STORE_NAME = 'queue';

/** How often the background drain loop runs when the tab is open.
 *  Trades freshness for request rate — 60s is well under the insights
 *  query cache TTL (5 min) so patterns stay responsive, and halves the
 *  number of no-op drains vs 30s. Emit() also triggers an immediate
 *  drain, so this interval is really just a retry cadence. */
const SYNC_INTERVAL_MS = 60_000;

/** Events drained in a single Supabase insert. Bumped from 20 so that
 *  bursty traffic (e.g. a user completing several blocks back-to-back)
 *  consolidates into one round-trip. Each event is ~200 bytes, so 100
 *  rows is ~20 KB per insert — well within Supabase payload limits. */
const BATCH_SIZE = 100;

const MAX_PENDING = 1000;

/** Hard ceiling on the IDB queue. ~200 bytes per event means 50k events
 *  is ~10 MB — well inside the browser quota, and represents ~1000 days
 *  of heavy use without a successful sync. In practice this should never
 *  be reached; if it is, something is badly broken and we surface it. */
const MAX_QUEUE_SIZE = 50_000;

/** Thresholds for the sync-health indicator. */
const HEALTH_FAILURE_THRESHOLD = 3;          // N consecutive failures → stuck
const HEALTH_STALE_MS = 24 * 60 * 60 * 1000; // queued events older than 24h → stuck

let db: IDBDatabase | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;
let pendingBuffer: QueuedEvent[] = [];
let approxQueueSize = 0;

// ── Sync health tracking ──
let consecutiveSyncFailures = 0;
let lastSuccessfulSync: number | null = null;
let lastSyncError: string | null = null;
let eventsDroppedAtCap = 0;

export interface SyncHealth {
  queueSize: number;
  consecutiveFailures: number;
  lastSuccessMs: number | null;
  lastError: string | null;
  eventsDroppedAtCap: number;
  stuck: boolean;
}

/** Public accessor for sync health — used to render the header indicator. */
export function getSyncHealth(): SyncHealth {
  const stuck =
    consecutiveSyncFailures >= HEALTH_FAILURE_THRESHOLD ||
    eventsDroppedAtCap > 0 ||
    (approxQueueSize > 0 &&
      lastSuccessfulSync != null &&
      Date.now() - lastSuccessfulSync > HEALTH_STALE_MS);
  return {
    queueSize: approxQueueSize,
    consecutiveFailures: consecutiveSyncFailures,
    lastSuccessMs: lastSuccessfulSync,
    lastError: lastSyncError,
    eventsDroppedAtCap,
    stuck,
  };
}

type SyncHealthListener = (h: SyncHealth) => void;
const healthListeners = new Set<SyncHealthListener>();

/** Subscribe to sync-health changes. Fires on every drain + enqueue-drop. */
export function onSyncHealthChange(fn: SyncHealthListener): () => void {
  healthListeners.add(fn);
  return () => healthListeners.delete(fn);
}

function notifyHealth(): void {
  const h = getSyncHealth();
  for (const fn of healthListeners) {
    try { fn(h); } catch (e) { console.warn('[events] health listener error:', e); }
  }
}

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
  if (!db) {
    if (pendingBuffer.length >= MAX_PENDING) {
      eventsDroppedAtCap++;
      console.error(
        `[events] DROPPED: in-memory buffer full (${MAX_PENDING} events). ` +
        `IDB has not initialized. Event type=${event.type} lost.`
      );
      notifyHealth();
      return;
    }
    pendingBuffer.push(event);
    return;
  }
  if (approxQueueSize >= MAX_QUEUE_SIZE) {
    eventsDroppedAtCap++;
    console.error(
      `[events] DROPPED: queue full (${MAX_QUEUE_SIZE} events). ` +
      `Sync has been failing. Event type=${event.type} lost. ` +
      `Check auth state + network. Total drops this session: ${eventsDroppedAtCap}`
    );
    notifyHealth();
    return;
  }
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(event);
    approxQueueSize++;
  } catch (e) {
    console.warn('[events] enqueue failed:', e);
  }
}

/** Flush any events that were buffered before IDB was ready. */
function flushPendingBuffer(): void {
  if (!db || pendingBuffer.length === 0) return;
  const buffered = pendingBuffer;
  pendingBuffer = [];
  for (const event of buffered) {
    enqueue(event);
  }
}

async function drainQueue(): Promise<void> {
  if (draining || !db || !state.userId) return;
  if (!navigator.onLine) return;
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
      local_dow: e.local_dow,
      local_hour: e.local_hour,
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
      approxQueueSize = Math.max(0, approxQueueSize - events.length);
      consecutiveSyncFailures = 0;
      lastSuccessfulSync = Date.now();
      lastSyncError = null;
      notifyHealth();
    } else {
      consecutiveSyncFailures++;
      lastSyncError = error.message;
      if (consecutiveSyncFailures === HEALTH_FAILURE_THRESHOLD) {
        console.error(
          `[events] SYNC STUCK: ${HEALTH_FAILURE_THRESHOLD} consecutive failures. ` +
          `${approxQueueSize} events queued locally. Last error: ${error.message}`
        );
      } else {
        console.warn(`[events] sync failed (${consecutiveSyncFailures}x), will retry:`, error.message);
      }
      notifyHealth();
    }
  } catch (e) {
    consecutiveSyncFailures++;
    lastSyncError = e instanceof Error ? e.message : String(e);
    console.warn('[events] drain error:', e);
    notifyHealth();
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

  const now = new Date();
  const queued: QueuedEvent = {
    user_id: state.userId,
    type: event.type,
    entity_id: event.entity_id || null,
    entity_type: event.entity_type || null,
    payload: enrichedPayload,
    local_dow: now.getDay(),      // 0=Sun..6=Sat in user's local timezone
    local_hour: now.getHours(),   // 0-23 in user's local timezone
    occurred_at: event.occurred_at || now.toISOString(),
  };

  enqueue(queued);

  // Trigger immediate drain (non-blocking)
  drainQueue();
}

/** Initialize the event system. Call once after auth. */
export async function initEvents(): Promise<void> {
  try {
    db = await openEventDB();
    // Sync approximate queue size from IDB
    const tx = db.transaction(STORE_NAME, 'readonly');
    const countReq = tx.objectStore(STORE_NAME).count();
    countReq.onsuccess = () => { approxQueueSize = countReq.result; };
    // Flush any events emitted before IDB was ready
    flushPendingBuffer();
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

/** Clear the IDB event queue. Call on sign-out to prevent cross-user data leaks. */
export async function clearEventQueue(): Promise<void> {
  stopSyncLoop();
  pendingBuffer = [];
  approxQueueSize = 0;
  consecutiveSyncFailures = 0;
  lastSuccessfulSync = null;
  lastSyncError = null;
  eventsDroppedAtCap = 0;
  if (db) {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
    } catch (e) {
      console.warn('[events] clear failed:', e);
    }
  }
  notifyHealth();
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
 *  Runs once per calendar day, on first app open. All dates are in the user's
 *  local timezone — `b.date` and `completion_date` are stored as local
 *  YYYY-MM-DD, so "yesterday" means yesterday-in-local-time. Using UTC here
 *  causes false expirations during evening hours in negative-UTC timezones. */
async function sweepExpiredBlocks(): Promise<void> {
  const todayStr = getTodayDate();

  // Only run once per local calendar day
  if (localStorage.getItem(SWEEP_KEY) === todayStr) return;

  const yesterdayStr = getDateOffsetFromToday(1);

  // Mon=0 day-of-week index for yesterday (matches block.days convention).
  const yesterdayLocal = new Date();
  yesterdayLocal.setDate(yesterdayLocal.getDate() - 1);
  const yesterdayDayIdx = yesterdayLocal.getDay() === 0 ? 6 : yesterdayLocal.getDay() - 1;

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

  // Emit block.expired for blocks with no interaction.
  // expiredAt = end of local-yesterday → ISO (UTC) for the timestamptz column.
  const midnight = new Date(yesterdayLocal);
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
