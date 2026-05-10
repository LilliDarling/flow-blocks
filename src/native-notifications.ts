import { isNative, nativePlatform } from './native.js';
import { Reminder, fmtTime, getTodayIndex } from './utils.js';

// Reserve low IDs (0-99) for non-reminder local notifications (pomodoro = 1).
const REMINDER_NOTIF_OFFSET = 100;

/** Stable 32-bit signed ID for a (reminder, day) pair. djb2-style hash of the
 *  UUID, masked to 27 bits, then 3 bits of day-index = unique slot per day.
 *  Same input → same ID, so re-scheduling replaces the prior pending notif
 *  and cancel is idempotent. */
function reminderNotifId(reminderId: string, dayIdx: number): number {
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
function nextOccurrence(time: string, dayIdx: number): Date {
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
function nextOccurrenceAfterToday(time: string, dayIdx: number): Date {
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
