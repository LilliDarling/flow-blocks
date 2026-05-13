import { isNative, nativePlatform } from './native.js';
import {
  Reminder, FlowBlock, EnergyLogRow, BlockStatus,
  TYPE_LABELS, fmtTime, getTodayIndex, getTodayDate, addMinutes, PomoMode,
} from './utils.js';

// ID layout (32-bit signed; max ≈ 2.15B):
//   1           = pomodoro completion (single slot)
//   2..6        = summary singletons (morning, midday, daily, pool, weekly)
//   100..       = reminders          (REMINDER_NOTIF_OFFSET + hash*8 + dayIdx)
//   1_200_000_000..  = block start   (BLOCK_START_OFFSET   + hash*8 + dayIdx)
//   1_600_000_000..  = block end     (BLOCK_END_OFFSET     + hash*8 + dayIdx)
// 'hash' is 25-bit masked djb2 → ~33M slots per category; plenty of headroom.
const POMO_NOTIF_ID = 1;
const MORNING_BRIEF_ID = 2;
const MIDDAY_PULSE_ID = 3;
const DAILY_NUDGE_ID = 4;
const POOL_NUDGE_ID = 5;
const WEEKLY_RECAP_ID = 6;
const REMINDER_NOTIF_OFFSET = 100;
const BLOCK_START_OFFSET = 1_200_000_000;
const BLOCK_END_OFFSET = 1_600_000_000;
const BLOCK_HASH_MASK = (1 << 25) - 1; // 25 bits → 33M slots

/** Stable 32-bit signed ID for a (reminder, day) pair. djb2-style hash of the
 *  UUID, masked to 27 bits, then 3 bits of day-index = unique slot per day.
 *  Same input → same ID, so re-scheduling replaces the prior pending notif
 *  and cancel is idempotent. */
export function reminderNotifId(reminderId: string, dayIdx: number): number {
  let h = 5381;
  for (let i = 0; i < reminderId.length; i++) {
    h = ((h << 5) + h + reminderId.charCodeAt(i)) | 0;
  }
  const base = Math.abs(h) % (1 << 27);
  return REMINDER_NOTIF_OFFSET + base * 8 + dayIdx;
}

/** Internal dayIdx (Mon=0..Sun=6) → next Date matching that weekday at HH:MM
 *  in device-local time. If today's occurrence has already passed, rolls
 *  forward by 7 days. */
export function nextOccurrence(time: string, dayIdx: number): Date {
  // JS getDay(): Sun=0..Sat=6 — convert from our Mon=0..Sun=6 layout.
  const jsDay = dayIdx === 6 ? 0 : dayIdx + 1;
  const [hh, mm] = time.split(':').map(Number);

  const now = new Date();
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);

  let daysToAdd = jsDay - now.getDay();
  if (daysToAdd < 0 || (daysToAdd === 0 && target.getTime() <= now.getTime())) {
    daysToAdd += 7;
  }
  target.setDate(target.getDate() + daysToAdd);
  return target;
}

/** Like nextOccurrence but never returns today — always at least 7 days out
 *  if today's the matching weekday. Used to suppress today's fire after the
 *  user has marked the reminder done or skipped. */
export function nextOccurrenceAfterToday(time: string, dayIdx: number): Date {
  const fire = nextOccurrence(time, dayIdx);
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const fireMidnight = new Date(fire);
  fireMidnight.setHours(0, 0, 0, 0);
  if (fireMidnight.getTime() === todayMidnight.getTime()) {
    fire.setDate(fire.getDate() + 7);
  }
  return fire;
}

async function ensurePermission(): Promise<boolean> {
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  const status = await LocalNotifications.checkPermissions();
  if (status.display === 'granted') return true;
  const req = await LocalNotifications.requestPermissions();
  return req.display === 'granted';
}

/** True when the OS will fire alarms at the exact scheduled time. On
 *  Android 12+ without SCHEDULE_EXACT_ALARM granted, the plugin falls back
 *  to inexact scheduling and Doze can defer alarms by ~9 minutes — that's
 *  the "10 minutes late" symptom. iOS and pre-Android-12 are always exact. */
export async function hasExactAlarmPermission(): Promise<boolean> {
  if (!isNative) return true;
  if (nativePlatform !== 'android') return true;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const status = await LocalNotifications.checkExactNotificationSetting();
    return status.exact_alarm === 'granted';
  } catch {
    return false;
  }
}

/** Deep-link the user into Android settings so they can flip the
 *  "Alarms & reminders" toggle for this app. Returns the post-grant state
 *  (the user may have denied). No-op on iOS or pre-Android-12. */
export async function requestExactAlarmPermission(): Promise<boolean> {
  if (!isNative) return true;
  if (nativePlatform !== 'android') return true;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const status = await LocalNotifications.changeExactNotificationSetting();
    return status.exact_alarm === 'granted';
  } catch {
    return false;
  }
}

interface ScheduleSpec {
  id: number;
  title: string;
  body: string;
  schedule: { at: Date; allowWhileIdle: true };
  smallIcon: string;
  extra: { reminderId: string; dayIdx: number; type: 'reminder' };
}

function buildSpec(reminder: Reminder, dayIdx: number, fireAt: Date): ScheduleSpec {
  return {
    id: reminderNotifId(reminder.id!, dayIdx),
    title: `${reminder.icon || '💊'} ${reminder.name}`,
    body: `Gentle reminder — it's ${fmtTime(reminder.time)}`,
    schedule: { at: fireAt, allowWhileIdle: true },
    smallIcon: 'ic_stat_icon',
    extra: { reminderId: reminder.id!, dayIdx, type: 'reminder' },
  };
}

/** Cancel any prior schedule for this reminder, then schedule the next
 *  one-shot occurrence for each day in reminder.days. If `suppressedToday`,
 *  today's slot is pushed to next week so a same-day complete/skip doesn't
 *  fire. Re-scheduling with the same notification ID replaces the prior
 *  pending one, so this is safe to call repeatedly. */
export async function scheduleReminderNative(reminder: Reminder, suppressedToday = false): Promise<void> {
  if (!isNative || !reminder.id || reminder.days.length === 0) return;

  try {
    const granted = await ensurePermission();
    if (!granted) return;

    const { LocalNotifications } = await import('@capacitor/local-notifications');

    // Cancel before re-scheduling so that days dropped on edit don't keep firing.
    await cancelReminderNative(reminder.id);

    const todayIdx = getTodayIndex();
    const notifications = reminder.days.map(dayIdx => {
      const fireAt = (dayIdx === todayIdx && suppressedToday)
        ? nextOccurrenceAfterToday(reminder.time, dayIdx)
        : nextOccurrence(reminder.time, dayIdx);
      return buildSpec(reminder, dayIdx, fireAt);
    });

    await LocalNotifications.schedule({ notifications });
  } catch (err) {
    console.warn('[native-notif] schedule reminder failed:', err);
  }
}

/** Cancel every (reminderId, day) slot for this reminder. Cancelling an ID
 *  that isn't pending is a harmless no-op, so we cancel all 7 day slots and
 *  don't need to remember which days were previously scheduled. */
export async function cancelReminderNative(reminderId: string): Promise<void> {
  if (!isNative) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const notifications = [];
    for (let d = 0; d < 7; d++) {
      notifications.push({ id: reminderNotifId(reminderId, d) });
    }
    await LocalNotifications.cancel({ notifications });
  } catch (err) {
    console.warn('[native-notif] cancel reminder failed:', err);
  }
}

/** Update today's slot for a reminder after its done/skip state changed.
 *    suppressed=true:  cancel today's pending fire, schedule next week's
 *    suppressed=false: re-schedule today's (if its time hasn't passed) or
 *                      next week's (if it has), so unmark/unskip restores
 *                      the alert when there's still time. */
export async function refreshReminderTodayNative(reminder: Reminder, suppressed: boolean): Promise<void> {
  if (!isNative || !reminder.id) return;
  const todayIdx = getTodayIndex();
  if (!reminder.days.includes(todayIdx)) return;

  try {
    const granted = await ensurePermission();
    if (!granted) return;

    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const fireAt = suppressed
      ? nextOccurrenceAfterToday(reminder.time, todayIdx)
      : nextOccurrence(reminder.time, todayIdx);

    await LocalNotifications.schedule({
      notifications: [buildSpec(reminder, todayIdx, fireAt)],
    });
  } catch (err) {
    console.warn('[native-notif] refresh today failed:', err);
  }
}

/** Top up missing slots. One-shot notifications disappear from `getPending`
 *  once they fire, so this catches:
 *    - notifications that fired while the app was killed (need next week)
 *    - any day where scheduling was missed (e.g. permission was granted late)
 *  Today's slot honours done/skipped state so we don't restore a fire the
 *  user already opted out of. Call on app resume. */
export async function refillRemindersNative(
  reminders: Reminder[],
  isSuppressedToday: (r: Reminder) => boolean,
): Promise<void> {
  if (!isNative) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const status = await LocalNotifications.checkPermissions();
    if (status.display !== 'granted') return;

    const { notifications: pending } = await LocalNotifications.getPending();
    const pendingIds = new Set(pending.map(n => n.id));

    const todayIdx = getTodayIndex();
    const toSchedule: ScheduleSpec[] = [];

    for (const r of reminders) {
      if (!r.id) continue;
      const suppressed = isSuppressedToday(r);
      for (const dayIdx of r.days) {
        const id = reminderNotifId(r.id, dayIdx);
        if (pendingIds.has(id)) continue;
        const fireAt = (dayIdx === todayIdx && suppressed)
          ? nextOccurrenceAfterToday(r.time, dayIdx)
          : nextOccurrence(r.time, dayIdx);
        toSchedule.push(buildSpec(r, dayIdx, fireAt));
      }
    }

    if (toSchedule.length > 0) {
      await LocalNotifications.schedule({ notifications: toSchedule });
    }
  } catch (err) {
    console.warn('[native-notif] refill failed:', err);
  }
}

/** Bootstrap on app load: re-schedule every reminder × day, honouring
 *  today's done/skipped state. Idempotent. */
export async function syncAllRemindersNative(
  reminders: Reminder[],
  isSuppressedToday: (r: Reminder) => boolean,
): Promise<void> {
  if (!isNative) return;
  for (const r of reminders) {
    if (!r.id) continue;
    await scheduleReminderNative(r, isSuppressedToday(r));
  }
}

// ─── Pomodoro completion ─────────────────────────────────────────────

/** Schedule the OS-level alarm that fires when the current pomo block
 *  (focus or break) completes. Single-slot — re-arming cancels first so
 *  pause/resume or mode-switch doesn't leave a stale alarm behind. */
export async function schedulePomoCompletionNative(
  fireAt: Date,
  mode: PomoMode,
  task = '',
): Promise<void> {
  if (!isNative) return;
  try {
    const granted = await ensurePermission();
    if (!granted) return;

    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.cancel({ notifications: [{ id: POMO_NOTIF_ID }] });

    const isFocus = mode === 'focus';
    await LocalNotifications.schedule({
      notifications: [{
        id: POMO_NOTIF_ID,
        title: isFocus ? 'Focus complete' : 'Break over',
        body: isFocus
          ? (task ? `"${task}" — time for a break.` : 'Great work — time for a break.')
          : 'Ready for another focus session?',
        schedule: { at: fireAt, allowWhileIdle: true },
        smallIcon: 'ic_stat_icon',
        extra: { type: 'pomo-complete' },
      }],
    });
  } catch (err) {
    console.warn('[native-notif] schedule pomo failed:', err);
  }
}

/** Cancel the pomodoro completion alarm. Safe to call when nothing is
 *  pending — cancel of a non-existent id is a no-op. */
export async function cancelPomoCompletionNative(): Promise<void> {
  if (!isNative) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.cancel({ notifications: [{ id: POMO_NOTIF_ID }] });
  } catch {
    /* plugin missing or already cancelled */
  }
}

// ─── Blocks (start + end) ────────────────────────────────────────────

function hashBlockId(blockId: string): number {
  let h = 5381;
  for (let i = 0; i < blockId.length; i++) {
    h = ((h << 5) + h + blockId.charCodeAt(i)) | 0;
  }
  return (Math.abs(h) & BLOCK_HASH_MASK) * 8;
}

export function blockStartNotifId(blockId: string, dayIdx: number): number {
  return BLOCK_START_OFFSET + hashBlockId(blockId) + dayIdx;
}

export function blockEndNotifId(blockId: string, dayIdx: number): number {
  return BLOCK_END_OFFSET + hashBlockId(blockId) + dayIdx;
}

const BLOCK_START_LEAD_MINUTES = 5;

function blockLabel(block: FlowBlock): string {
  return block.title || TYPE_LABELS[block.type];
}

interface BlockNotifSpec {
  id: number;
  title: string;
  body: string;
  schedule: { at: Date; allowWhileIdle: true };
  smallIcon: string;
  extra: { blockId: string; dayIdx: number; type: 'block-start' | 'block-end' };
}

function buildBlockStartSpec(block: FlowBlock, dayIdx: number, fireAt: Date): BlockNotifSpec {
  const label = blockLabel(block);
  return {
    id: blockStartNotifId(block.id!, dayIdx),
    title: `Starting soon: ${label}`,
    body: `Your ${block.type} block begins at ${fmtTime(block.start)}`,
    schedule: { at: fireAt, allowWhileIdle: true },
    smallIcon: 'ic_stat_icon',
    extra: { blockId: block.id!, dayIdx, type: 'block-start' },
  };
}

function buildBlockEndSpec(block: FlowBlock, dayIdx: number, fireAt: Date): BlockNotifSpec {
  const label = blockLabel(block);
  return {
    id: blockEndNotifId(block.id!, dayIdx),
    title: `${label} just wrapped`,
    body: 'Did you finish?',
    schedule: { at: fireAt, allowWhileIdle: true },
    smallIcon: 'ic_stat_icon',
    extra: { blockId: block.id!, dayIdx, type: 'block-end' },
  };
}

/** Combine a "YYYY-MM-DD" local date with an "HH:MM" time into a Date in
 *  device-local time. Used for one-off (dated) blocks. */
function dateTimeAt(localDate: string, time: string): Date {
  const [y, m, d] = localDate.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function isPoolOrUnscheduled(block: FlowBlock): boolean {
  return !block.start || block.start.length === 0;
}

function isOneOff(block: FlowBlock): boolean {
  return !!block.date;
}

/** Schedule start + end alarms for a block.
 *  - Recurring (days[]): one start+end pair per day in `days`. If
 *    `suppressedToday` and today matches one of those days, today's pair is
 *    pushed to next week.
 *  - One-off (date set): single start+end pair at that absolute moment.
 *    Skipped entirely if already past, already done, or already skipped.
 *  Re-arming with the same notification IDs replaces prior pending ones, so
 *  this is safe to call repeatedly. */
export async function scheduleBlockNotifsNative(
  block: FlowBlock,
  suppressedToday = false,
): Promise<void> {
  if (!isNative || !block.id) return;
  if (isPoolOrUnscheduled(block)) return;

  try {
    if (isOneOff(block)) {
      // One-off: skip if status precludes firing, or if start has already passed.
      if (block.status === 'done' || block.status === 'skipped' || block.status === 'dismissed') return;

      const startAt = dateTimeAt(block.date!, block.start);
      const leadAt = new Date(startAt.getTime() - BLOCK_START_LEAD_MINUTES * 60_000);
      const endAt = dateTimeAt(block.date!, addMinutes(block.start, block.duration));

      const now = new Date();
      if (leadAt.getTime() <= now.getTime() && endAt.getTime() <= now.getTime()) return;

      const granted = await ensurePermission();
      if (!granted) return;

      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await cancelBlockNotifsNative(block.id);

      const notifications: BlockNotifSpec[] = [];
      if (leadAt.getTime() > now.getTime()) {
        notifications.push(buildBlockStartSpec(block, 0, leadAt));
      }
      if (endAt.getTime() > now.getTime()) {
        notifications.push(buildBlockEndSpec(block, 0, endAt));
      }
      if (notifications.length > 0) {
        await LocalNotifications.schedule({ notifications });
      }
      return;
    }

    // Recurring: one pair per day in `days`.
    if (block.days.length === 0) return;

    const granted = await ensurePermission();
    if (!granted) return;

    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await cancelBlockNotifsNative(block.id);

    const todayIdx = getTodayIndex();
    const endTime = addMinutes(block.start, block.duration);
    const notifications: BlockNotifSpec[] = [];

    for (const dayIdx of block.days) {
      const isToday = dayIdx === todayIdx;
      const startOcc = (isToday && suppressedToday)
        ? nextOccurrenceAfterToday(block.start, dayIdx)
        : nextOccurrence(block.start, dayIdx);
      // End fires on the same calendar day as start. Compute end from the
      // chosen start occurrence so duration-spanning-midnight still works.
      const endOcc = new Date(startOcc);
      const [eh, em] = endTime.split(':').map(Number);
      // If end time-of-day is earlier than start time-of-day, the duration
      // crosses midnight — bump to next day.
      const startMins = toMinutesLocal(block.start);
      const endMins = toMinutesLocal(endTime);
      if (endMins <= startMins) endOcc.setDate(endOcc.getDate() + 1);
      endOcc.setHours(eh, em, 0, 0);

      // Lead-time: 5 min before start. Could land in the past for today's
      // slot — in that case skip the start notification but still schedule end.
      const leadOcc = new Date(startOcc.getTime() - BLOCK_START_LEAD_MINUTES * 60_000);
      const now = Date.now();

      if (leadOcc.getTime() > now) {
        notifications.push(buildBlockStartSpec(block, dayIdx, leadOcc));
      }
      if (endOcc.getTime() > now) {
        notifications.push(buildBlockEndSpec(block, dayIdx, endOcc));
      }
    }

    if (notifications.length > 0) {
      await LocalNotifications.schedule({ notifications });
    }
  } catch (err) {
    console.warn('[native-notif] schedule block failed:', err);
  }
}

function toMinutesLocal(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Cancel every (start, end) × day slot for a block. Idempotent. */
export async function cancelBlockNotifsNative(blockId: string): Promise<void> {
  if (!isNative) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const notifications: Array<{ id: number }> = [];
    for (let d = 0; d < 7; d++) {
      notifications.push({ id: blockStartNotifId(blockId, d) });
      notifications.push({ id: blockEndNotifId(blockId, d) });
    }
    await LocalNotifications.cancel({ notifications });
  } catch (err) {
    console.warn('[native-notif] cancel block failed:', err);
  }
}

/** Update today's start+end slot after a recurring block's status changes
 *  (done/skipped/restored). Mirrors refreshReminderTodayNative. No-op on
 *  one-off blocks (their suppression is full-cancel via cancelBlockNotifsNative). */
export async function refreshBlockTodayNative(block: FlowBlock, suppressed: boolean): Promise<void> {
  if (!isNative || !block.id) return;
  if (isPoolOrUnscheduled(block) || isOneOff(block)) return;

  const todayIdx = getTodayIndex();
  if (!block.days.includes(todayIdx)) return;

  try {
    const granted = await ensurePermission();
    if (!granted) return;

    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const endTime = addMinutes(block.start, block.duration);

    const startOcc = suppressed
      ? nextOccurrenceAfterToday(block.start, todayIdx)
      : nextOccurrence(block.start, todayIdx);
    const endOcc = new Date(startOcc);
    const [eh, em] = endTime.split(':').map(Number);
    const startMins = toMinutesLocal(block.start);
    const endMins = toMinutesLocal(endTime);
    if (endMins <= startMins) endOcc.setDate(endOcc.getDate() + 1);
    endOcc.setHours(eh, em, 0, 0);
    const leadOcc = new Date(startOcc.getTime() - BLOCK_START_LEAD_MINUTES * 60_000);

    const notifications: BlockNotifSpec[] = [];
    const now = Date.now();
    if (leadOcc.getTime() > now) {
      notifications.push(buildBlockStartSpec(block, todayIdx, leadOcc));
    }
    if (endOcc.getTime() > now) {
      notifications.push(buildBlockEndSpec(block, todayIdx, endOcc));
    }
    if (notifications.length > 0) {
      await LocalNotifications.schedule({ notifications });
    }
  } catch (err) {
    console.warn('[native-notif] refresh block today failed:', err);
  }
}

/** Top up missing block slots on app resume. Like refillRemindersNative:
 *  enumerate the (start, end) × day slots we *should* have pending and
 *  schedule only the ones missing from the OS pending list. */
export async function refillBlockNotifsNative(
  blocks: FlowBlock[],
  isSuppressedToday: (b: FlowBlock) => boolean,
): Promise<void> {
  if (!isNative) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const status = await LocalNotifications.checkPermissions();
    if (status.display !== 'granted') return;

    const { notifications: pending } = await LocalNotifications.getPending();
    const pendingIds = new Set(pending.map((n: { id: number }) => n.id));

    const todayIdx = getTodayIndex();
    const toSchedule: BlockNotifSpec[] = [];
    const now = Date.now();

    for (const block of blocks) {
      if (!block.id || isPoolOrUnscheduled(block)) continue;

      if (isOneOff(block)) {
        if (block.status === 'done' || block.status === 'skipped' || block.status === 'dismissed') continue;
        const startAt = dateTimeAt(block.date!, block.start);
        const leadAt = new Date(startAt.getTime() - BLOCK_START_LEAD_MINUTES * 60_000);
        const endAt = dateTimeAt(block.date!, addMinutes(block.start, block.duration));
        const startId = blockStartNotifId(block.id, 0);
        const endId = blockEndNotifId(block.id, 0);
        if (leadAt.getTime() > now && !pendingIds.has(startId)) {
          toSchedule.push(buildBlockStartSpec(block, 0, leadAt));
        }
        if (endAt.getTime() > now && !pendingIds.has(endId)) {
          toSchedule.push(buildBlockEndSpec(block, 0, endAt));
        }
        continue;
      }

      if (block.days.length === 0) continue;
      const suppressed = isSuppressedToday(block);
      const endTime = addMinutes(block.start, block.duration);

      for (const dayIdx of block.days) {
        const startOcc = (dayIdx === todayIdx && suppressed)
          ? nextOccurrenceAfterToday(block.start, dayIdx)
          : nextOccurrence(block.start, dayIdx);
        const endOcc = new Date(startOcc);
        const [eh, em] = endTime.split(':').map(Number);
        if (toMinutesLocal(endTime) <= toMinutesLocal(block.start)) {
          endOcc.setDate(endOcc.getDate() + 1);
        }
        endOcc.setHours(eh, em, 0, 0);
        const leadOcc = new Date(startOcc.getTime() - BLOCK_START_LEAD_MINUTES * 60_000);

        const startId = blockStartNotifId(block.id, dayIdx);
        const endId = blockEndNotifId(block.id, dayIdx);
        if (leadOcc.getTime() > now && !pendingIds.has(startId)) {
          toSchedule.push(buildBlockStartSpec(block, dayIdx, leadOcc));
        }
        if (endOcc.getTime() > now && !pendingIds.has(endId)) {
          toSchedule.push(buildBlockEndSpec(block, dayIdx, endOcc));
        }
      }
    }

    if (toSchedule.length > 0) {
      await LocalNotifications.schedule({ notifications: toSchedule });
    }
  } catch (err) {
    console.warn('[native-notif] refill blocks failed:', err);
  }
}

/** Bootstrap on app load: re-schedule every block. Idempotent. */
export async function syncAllBlocksNative(
  blocks: FlowBlock[],
  isSuppressedToday: (b: FlowBlock) => boolean,
): Promise<void> {
  if (!isNative) return;
  for (const b of blocks) {
    if (!b.id) continue;
    await scheduleBlockNotifsNative(b, isSuppressedToday(b));
  }
}

// ─── Summary notifications (singletons) ──────────────────────────────

/** Next local Date at hour:00 — today if not yet passed, else tomorrow. */
function nextDailyAt(hour: number, minute = 0): Date {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target;
}

interface SummarySpec {
  id: number;
  title: string;
  body: string;
  schedule: { at: Date; allowWhileIdle: true };
  smallIcon: string;
  extra: { type: string };
}

async function scheduleSingleton(spec: SummarySpec): Promise<void> {
  if (!isNative) return;
  try {
    const granted = await ensurePermission();
    if (!granted) return;
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.cancel({ notifications: [{ id: spec.id }] });
    await LocalNotifications.schedule({ notifications: [spec] });
  } catch (err) {
    console.warn(`[native-notif] schedule summary id=${spec.id} failed:`, err);
  }
}

async function cancelSingleton(id: number): Promise<void> {
  if (!isNative) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.cancel({ notifications: [{ id }] });
  } catch {
    /* already cancelled or plugin missing */
  }
}

/** Daily 8 PM "how'd today go" nudge. */
export async function scheduleDailyNudgeNative(): Promise<void> {
  const at = nextDailyAt(20);
  await scheduleSingleton({
    id: DAILY_NUDGE_ID,
    title: "How'd today go?",
    body: 'Take a sec to check off what you got done.',
    schedule: { at, allowWhileIdle: true },
    smallIcon: 'ic_stat_icon',
    extra: { type: 'daily-review' },
  });
}

/** Find the next future scheduled block-start moment, considering recurring
 *  days[] (matching local weekday) and one-off dated blocks. Returns null if
 *  no upcoming start exists within the next 7 days. */
function nextScheduledBlockStart(blocks: FlowBlock[]): { at: Date; block: FlowBlock } | null {
  const now = new Date();
  let best: { at: Date; block: FlowBlock } | null = null;

  for (const b of blocks) {
    if (isPoolOrUnscheduled(b)) continue;

    let at: Date | null = null;
    if (isOneOff(b)) {
      if (b.status === 'done' || b.status === 'skipped' || b.status === 'dismissed') continue;
      const candidate = dateTimeAt(b.date!, b.start);
      if (candidate.getTime() > now.getTime()) at = candidate;
    } else if (b.days.length > 0) {
      let earliest: Date | null = null;
      for (const dayIdx of b.days) {
        const occ = nextOccurrence(b.start, dayIdx);
        if (!earliest || occ.getTime() < earliest.getTime()) earliest = occ;
      }
      at = earliest;
    }

    if (!at) continue;
    if (!best || at.getTime() < best.at.getTime()) best = { at, block: b };
  }

  return best;
}

/** Morning briefing — fires 15 min before the next upcoming first block of
 *  the day, clamped to 7 AM minimum. No-op if there are no scheduled blocks. */
export async function scheduleMorningBriefNative(blocks: FlowBlock[]): Promise<void> {
  if (!isNative) return;
  const next = nextScheduledBlockStart(blocks);
  if (!next) {
    await cancelSingleton(MORNING_BRIEF_ID);
    return;
  }

  // Brief fires at max(firstBlock - 15min, 07:00) on the same local date as
  // the first block. If "now" is already past the briefing window for today,
  // we'll naturally pick the next future block-start, whose lead-time falls
  // on its own day.
  const fireAt = new Date(next.at.getTime() - 15 * 60_000);
  const minMorning = new Date(next.at);
  minMorning.setHours(7, 0, 0, 0);
  const at = fireAt.getTime() < minMorning.getTime() ? minMorning : fireAt;

  if (at.getTime() <= Date.now()) {
    await cancelSingleton(MORNING_BRIEF_ID);
    return;
  }

  const label = blockLabel(next.block);
  await scheduleSingleton({
    id: MORNING_BRIEF_ID,
    title: 'Morning brief',
    body: `First up: ${label} at ${fmtTime(next.block.start)}`,
    schedule: { at, allowWhileIdle: true },
    smallIcon: 'ic_stat_icon',
    extra: { type: 'morning-brief' },
  });
}

/** Midday pulse — 1 PM check-in. Suppressed when the user has recently
 *  logged energy or has no pending blocks today. Always cancels its own
 *  slot first so a previously-scheduled pulse is cleared when conditions
 *  flip to suppression. */
export async function scheduleMiddayPulseNative(
  blocks: FlowBlock[],
  recentlyLoggedEnergy: boolean,
): Promise<void> {
  if (!isNative) return;
  await cancelSingleton(MIDDAY_PULSE_ID);
  if (recentlyLoggedEnergy) return;

  // Must have at least one scheduled block (pending) for the pulse to be
  // meaningful — otherwise there's nothing to nudge about.
  const hasScheduled = blocks.some(b => !isPoolOrUnscheduled(b)
    && b.status !== 'done' && b.status !== 'skipped' && b.status !== 'dismissed');
  if (!hasScheduled) return;

  const at = nextDailyAt(13);
  await scheduleSingleton({
    id: MIDDAY_PULSE_ID,
    title: 'Midday check-in',
    body: "How's the day going?",
    schedule: { at, allowWhileIdle: true },
    smallIcon: 'ic_stat_icon',
    extra: { type: 'daily-review' },
  });
}

/** Pool nudge — 2 PM reminder that there are pool items waiting. Only
 *  fires when there are pool items AND no scheduled blocks today AND user
 *  hasn't been recently active. */
export async function schedulePoolNudgeNative(opts: {
  hasPoolItems: boolean;
  hasScheduledBlocksToday: boolean;
  recentlyActive: boolean;
}): Promise<void> {
  if (!isNative) return;
  await cancelSingleton(POOL_NUDGE_ID);
  if (!opts.hasPoolItems || opts.hasScheduledBlocksToday || opts.recentlyActive) return;

  const at = nextDailyAt(14);
  await scheduleSingleton({
    id: POOL_NUDGE_ID,
    title: 'Anything calling to you?',
    body: 'Got the energy for one pool item?',
    schedule: { at, allowWhileIdle: true },
    smallIcon: 'ic_stat_icon',
    extra: { type: 'pool-nudge' },
  });
}

/** Weekly recap — Sunday 7 PM. Body is generic; the recap view itself
 *  computes counts when opened. */
export async function scheduleWeeklyRecapNative(): Promise<void> {
  if (!isNative) return;
  const now = new Date();
  // JS day: 0=Sun..6=Sat. We want next Sunday at 19:00; today if it's Sunday
  // and 19:00 hasn't passed.
  const target = new Date(now);
  target.setHours(19, 0, 0, 0);
  const daysUntilSunday = (7 - now.getDay()) % 7;
  if (daysUntilSunday === 0) {
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 7);
  } else {
    target.setDate(target.getDate() + daysUntilSunday);
  }
  await scheduleSingleton({
    id: WEEKLY_RECAP_ID,
    title: 'Your week in review',
    body: 'Tap to see how the week went.',
    schedule: { at: target, allowWhileIdle: true },
    smallIcon: 'ic_stat_icon',
    extra: { type: 'weekly-recap' },
  });
}

// ─── Summary orchestration ───────────────────────────────────────────

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function hasPendingPool(blocks: FlowBlock[]): boolean {
  return blocks.some(b => isPoolOrUnscheduled(b)
    && b.status !== 'done' && b.status !== 'skipped' && b.status !== 'dismissed');
}

function hasPendingScheduledToday(
  blocks: FlowBlock[],
  completions: Map<string, BlockStatus>,
): boolean {
  const today = getTodayDate();
  const todayIdx = getTodayIndex();
  for (const b of blocks) {
    if (isPoolOrUnscheduled(b) || !b.id) continue;
    if (isOneOff(b)) {
      if (b.date !== today) continue;
      if (b.status === 'done' || b.status === 'skipped' || b.status === 'dismissed') continue;
      return true;
    } else {
      if (!b.days.includes(todayIdx)) continue;
      const status = completions.get(`${b.id}_${today}`);
      if (status === 'done' || status === 'skipped' || status === 'dismissed') continue;
      return true;
    }
  }
  return false;
}

function recentlyLoggedEnergy(logs: EnergyLogRow[]): boolean {
  const cutoff = Date.now() - TWO_HOURS_MS;
  return logs.some(l => new Date(l.logged_at).getTime() >= cutoff);
}

/** Re-arm all summary singletons based on current state. Cheap to call —
 *  each scheduler is idempotent and cancels its own slot first. Call after
 *  block CRUD/status changes, energy logs, and on app boot/resume. */
export async function syncSummariesNative(snapshot: {
  blocks: FlowBlock[];
  completions: Map<string, BlockStatus>;
  energyLogs: EnergyLogRow[];
}): Promise<void> {
  if (!isNative) return;
  const active = recentlyLoggedEnergy(snapshot.energyLogs);
  await Promise.all([
    scheduleDailyNudgeNative(),
    scheduleMorningBriefNative(snapshot.blocks),
    scheduleMiddayPulseNative(snapshot.blocks, active),
    schedulePoolNudgeNative({
      hasPoolItems: hasPendingPool(snapshot.blocks),
      hasScheduledBlocksToday: hasPendingScheduledToday(snapshot.blocks, snapshot.completions),
      recentlyActive: active,
    }),
    scheduleWeeklyRecapNative(),
  ]);
}

/** Cancel all five summary singletons. Useful on sign-out or when toggling
 *  notifications off. */
export async function cancelSummaryNotifsNative(): Promise<void> {
  if (!isNative) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.cancel({
      notifications: [
        { id: MORNING_BRIEF_ID },
        { id: MIDDAY_PULSE_ID },
        { id: DAILY_NUDGE_ID },
        { id: POOL_NUDGE_ID },
        { id: WEEKLY_RECAP_ID },
      ],
    });
  } catch {
    /* already cancelled or plugin missing */
  }
}
