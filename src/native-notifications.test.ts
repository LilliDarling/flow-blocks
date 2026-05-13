import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./native.js', () => ({
  isNative: true,
  nativePlatform: 'android',
}));

const mockSchedule = vi.fn();
const mockCancel = vi.fn();
const mockGetPending = vi.fn();
const mockCheckPermissions = vi.fn();
const mockRequestPermissions = vi.fn();

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: mockSchedule,
    cancel: mockCancel,
    getPending: mockGetPending,
    checkPermissions: mockCheckPermissions,
    requestPermissions: mockRequestPermissions,
  },
}));

import {
  reminderNotifId,
  nextOccurrence,
  nextOccurrenceAfterToday,
  scheduleReminderNative,
  cancelReminderNative,
  refreshReminderTodayNative,
  refillRemindersNative,
  schedulePomoCompletionNative,
  cancelPomoCompletionNative,
  blockStartNotifId,
  blockEndNotifId,
  scheduleBlockNotifsNative,
  cancelBlockNotifsNative,
  refreshBlockTodayNative,
  refillBlockNotifsNative,
  scheduleDailyNudgeNative,
  scheduleMorningBriefNative,
  scheduleMiddayPulseNative,
  schedulePoolNudgeNative,
  scheduleWeeklyRecapNative,
  cancelSummaryNotifsNative,
} from './native-notifications.js';
import type { Reminder, FlowBlock } from './utils.js';

const makeReminder = (overrides: Partial<Reminder> = {}): Reminder => ({
  id: 'r-1',
  name: 'Vitamins',
  time: '08:00',
  days: [0, 1, 2, 3, 4], // Mon–Fri
  icon: '💊',
  ...overrides,
});

beforeEach(() => {
  mockSchedule.mockReset();
  mockCancel.mockReset();
  mockGetPending.mockReset();
  mockCheckPermissions.mockReset();
  mockRequestPermissions.mockReset();
  mockCheckPermissions.mockResolvedValue({ display: 'granted' });
  mockRequestPermissions.mockResolvedValue({ display: 'granted' });
  mockGetPending.mockResolvedValue({ notifications: [] });
  mockSchedule.mockResolvedValue(undefined);
  mockCancel.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reminderNotifId', () => {
  it('produces a stable ID for the same (id, dayIdx)', () => {
    expect(reminderNotifId('abc', 0)).toBe(reminderNotifId('abc', 0));
  });

  it('produces distinct IDs per dayIdx for the same reminder', () => {
    const ids = new Set([0, 1, 2, 3, 4, 5, 6].map(d => reminderNotifId('r-1', d)));
    expect(ids.size).toBe(7);
  });

  it('produces different IDs for different reminders', () => {
    expect(reminderNotifId('r-1', 0)).not.toBe(reminderNotifId('r-2', 0));
  });

  it('stays in the reminder ID range (>= 100)', () => {
    expect(reminderNotifId('any-uuid-here', 0)).toBeGreaterThanOrEqual(100);
  });

  it('produces a positive 32-bit-safe integer', () => {
    const id = reminderNotifId('550e8400-e29b-41d4-a716-446655440000', 3);
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThan(2 ** 31);
    expect(Number.isInteger(id)).toBe(true);
  });
});

describe('nextOccurrence', () => {
  it('returns today at the time if the time is in the future and today matches', () => {
    // 2026-05-13 is a Wednesday → dayIdx 2 in Mon=0 layout
    vi.setSystemTime(new Date('2026-05-13T07:00:00'));
    const fire = nextOccurrence('08:00', 2);
    expect(fire.getFullYear()).toBe(2026);
    expect(fire.getMonth()).toBe(4);
    expect(fire.getDate()).toBe(13);
    expect(fire.getHours()).toBe(8);
    expect(fire.getMinutes()).toBe(0);
  });

  it('rolls to next week if today matches but the time has passed', () => {
    vi.setSystemTime(new Date('2026-05-13T09:00:00')); // Wed, after 08:00
    const fire = nextOccurrence('08:00', 2);
    expect(fire.getDate()).toBe(20); // next Wed
  });

  it('rolls forward to the next matching weekday in the same week', () => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00')); // Wed
    const fire = nextOccurrence('08:00', 4); // Fri (dayIdx 4)
    expect(fire.getDate()).toBe(15); // Fri
  });

  it('rolls into next week when the target weekday has already passed this week', () => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00')); // Wed
    const fire = nextOccurrence('08:00', 0); // Mon (dayIdx 0) — already passed
    expect(fire.getDate()).toBe(18); // next Mon
  });

  it('handles Sunday correctly (dayIdx 6 → JS Sunday)', () => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00')); // Wed
    const fire = nextOccurrence('20:00', 6); // Sun
    expect(fire.getDay()).toBe(0);
    expect(fire.getDate()).toBe(17);
  });
});

describe('nextOccurrenceAfterToday', () => {
  it('pushes today\'s slot to next week', () => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00')); // Wed
    const fire = nextOccurrenceAfterToday('08:00', 2); // Wed slot
    expect(fire.getDate()).toBe(20); // next Wed, not today
  });

  it('matches nextOccurrence when target weekday is not today', () => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00')); // Wed
    expect(nextOccurrenceAfterToday('08:00', 4).getTime())
      .toBe(nextOccurrence('08:00', 4).getTime());
  });
});

describe('scheduleReminderNative', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00')); // Wed
  });

  it('cancels prior slots then schedules one notification per day', async () => {
    const r = makeReminder({ days: [0, 2, 4] });
    await scheduleReminderNative(r);

    expect(mockCancel).toHaveBeenCalledOnce();
    expect(mockSchedule).toHaveBeenCalledOnce();
    const arg = mockSchedule.mock.calls[0][0];
    expect(arg.notifications).toHaveLength(3);
  });

  it('passes title with icon and body with formatted time', async () => {
    const r = makeReminder({ days: [2], time: '14:30', icon: '🌿', name: 'Stretch' });
    await scheduleReminderNative(r);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect(notif.title).toBe('🌿 Stretch');
    expect(notif.body).toContain('2:30 PM');
  });

  it('sets smallIcon and allowWhileIdle', async () => {
    const r = makeReminder({ days: [2] });
    await scheduleReminderNative(r);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect(notif.smallIcon).toBe('ic_stat_icon');
    expect(notif.schedule.allowWhileIdle).toBe(true);
  });

  it('pushes today\'s slot to next week when suppressed', async () => {
    const r = makeReminder({ days: [2] }); // Wed only
    await scheduleReminderNative(r, true);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    const fireAt = notif.schedule.at as Date;
    expect(fireAt.getDate()).toBe(20); // next Wed
  });

  it('no-ops if days is empty', async () => {
    await scheduleReminderNative(makeReminder({ days: [] }));
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('no-ops if id is missing', async () => {
    await scheduleReminderNative(makeReminder({ id: undefined }));
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('requests permission when not granted, then schedules', async () => {
    mockCheckPermissions.mockResolvedValue({ display: 'denied' });
    mockRequestPermissions.mockResolvedValue({ display: 'granted' });
    await scheduleReminderNative(makeReminder({ days: [2] }));
    expect(mockRequestPermissions).toHaveBeenCalledOnce();
    expect(mockSchedule).toHaveBeenCalledOnce();
  });

  it('skips scheduling when permission denied', async () => {
    mockCheckPermissions.mockResolvedValue({ display: 'denied' });
    mockRequestPermissions.mockResolvedValue({ display: 'denied' });
    await scheduleReminderNative(makeReminder({ days: [2] }));
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('cancelReminderNative', () => {
  it('cancels all 7 day slots for a reminder', async () => {
    await cancelReminderNative('r-1');
    expect(mockCancel).toHaveBeenCalledOnce();
    const arg = mockCancel.mock.calls[0][0];
    expect(arg.notifications).toHaveLength(7);
    const ids = arg.notifications.map((n: { id: number }) => n.id);
    expect(new Set(ids).size).toBe(7);
  });
});

describe('refreshReminderTodayNative', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00')); // Wed, dayIdx 2
  });

  it('schedules today when not suppressed and today matches', async () => {
    const r = makeReminder({ days: [2] });
    await refreshReminderTodayNative(r, false);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect((notif.schedule.at as Date).getDate()).toBe(13);
  });

  it('pushes today to next week when suppressed', async () => {
    const r = makeReminder({ days: [2] });
    await refreshReminderTodayNative(r, true);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect((notif.schedule.at as Date).getDate()).toBe(20);
  });

  it('no-ops when today is not in the reminder\'s days', async () => {
    const r = makeReminder({ days: [0, 1] }); // Mon, Tue — not Wed
    await refreshReminderTodayNative(r, false);
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('refillRemindersNative', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00'));
  });

  it('schedules only the days not already pending', async () => {
    const r = makeReminder({ days: [0, 2, 4] });
    // Pretend the Mon slot is already pending; Wed + Fri are missing.
    mockGetPending.mockResolvedValue({
      notifications: [{ id: reminderNotifId('r-1', 0) }],
    });
    await refillRemindersNative([r], () => false);
    expect(mockSchedule).toHaveBeenCalledOnce();
    const arg = mockSchedule.mock.calls[0][0];
    expect(arg.notifications).toHaveLength(2);
  });

  it('honors today\'s suppression when refilling', async () => {
    const r = makeReminder({ days: [2] }); // Wed only
    mockGetPending.mockResolvedValue({ notifications: [] });
    await refillRemindersNative([r], () => true);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect((notif.schedule.at as Date).getDate()).toBe(20); // next Wed
  });

  it('does not call schedule if nothing is missing', async () => {
    const r = makeReminder({ days: [2] });
    mockGetPending.mockResolvedValue({
      notifications: [{ id: reminderNotifId('r-1', 2) }],
    });
    await refillRemindersNative([r], () => false);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('no-ops when permission is not granted', async () => {
    mockCheckPermissions.mockResolvedValue({ display: 'denied' });
    await refillRemindersNative([makeReminder()], () => false);
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('schedulePomoCompletionNative', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
  });

  it('schedules a notification with the pomodoro reserved id', async () => {
    await schedulePomoCompletionNative(new Date('2026-05-13T10:25:00'), 'focus');
    expect(mockSchedule).toHaveBeenCalledOnce();
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect(notif.id).toBe(1);
  });

  it('cancels any prior pomo notification before scheduling (idempotent re-arm)', async () => {
    await schedulePomoCompletionNative(new Date('2026-05-13T10:25:00'), 'focus');
    expect(mockCancel).toHaveBeenCalled();
    const cancelArg = mockCancel.mock.calls[0][0];
    expect(cancelArg.notifications).toEqual([{ id: 1 }]);
  });

  it('uses "Focus complete" title for focus mode', async () => {
    await schedulePomoCompletionNative(new Date('2026-05-13T10:25:00'), 'focus');
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect(notif.title).toBe('Focus complete');
  });

  it('uses "Break over" title for short and long break modes', async () => {
    await schedulePomoCompletionNative(new Date('2026-05-13T10:05:00'), 'short');
    expect(mockSchedule.mock.calls[0][0].notifications[0].title).toBe('Break over');
    await schedulePomoCompletionNative(new Date('2026-05-13T10:15:00'), 'long');
    expect(mockSchedule.mock.calls[1][0].notifications[0].title).toBe('Break over');
  });

  it('includes the task name in the focus body when provided', async () => {
    await schedulePomoCompletionNative(new Date('2026-05-13T10:25:00'), 'focus', 'Write report');
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect(notif.body).toContain('Write report');
  });

  it('falls back to a generic focus body when task is empty', async () => {
    await schedulePomoCompletionNative(new Date('2026-05-13T10:25:00'), 'focus');
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect(notif.body).toMatch(/great work|time for a break/i);
  });

  it('sets smallIcon and allowWhileIdle', async () => {
    await schedulePomoCompletionNative(new Date('2026-05-13T10:25:00'), 'focus');
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect(notif.smallIcon).toBe('ic_stat_icon');
    expect(notif.schedule.allowWhileIdle).toBe(true);
    expect(notif.schedule.at.getTime()).toBe(new Date('2026-05-13T10:25:00').getTime());
  });

  it('skips when permission is denied', async () => {
    mockCheckPermissions.mockResolvedValue({ display: 'denied' });
    mockRequestPermissions.mockResolvedValue({ display: 'denied' });
    await schedulePomoCompletionNative(new Date('2026-05-13T10:25:00'), 'focus');
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('cancelPomoCompletionNative', () => {
  it('cancels the pomodoro reserved id', async () => {
    await cancelPomoCompletionNative();
    expect(mockCancel).toHaveBeenCalledOnce();
    expect(mockCancel.mock.calls[0][0]).toEqual({ notifications: [{ id: 1 }] });
  });
});

// ─── Blocks ──────────────────────────────────────────────────────────

const makeBlock = (overrides: Partial<FlowBlock> = {}): FlowBlock => ({
  id: 'b-1',
  type: 'flow',
  title: 'Deep work',
  menu: [],
  start: '09:00',
  duration: 60,
  days: [0, 1, 2, 3, 4], // Mon–Fri
  date: null,
  status: 'pending',
  ...overrides,
});

describe('blockStartNotifId / blockEndNotifId', () => {
  it('produces stable IDs for the same (blockId, dayIdx)', () => {
    expect(blockStartNotifId('b-1', 0)).toBe(blockStartNotifId('b-1', 0));
    expect(blockEndNotifId('b-1', 0)).toBe(blockEndNotifId('b-1', 0));
  });

  it('produces distinct IDs across the 7 day slots', () => {
    const startIds = new Set([0, 1, 2, 3, 4, 5, 6].map(d => blockStartNotifId('b-1', d)));
    expect(startIds.size).toBe(7);
  });

  it('produces distinct ID ranges for start vs end (no collisions for same block+day)', () => {
    for (let d = 0; d < 7; d++) {
      expect(blockStartNotifId('b-1', d)).not.toBe(blockEndNotifId('b-1', d));
    }
  });

  it('produces IDs disjoint from reminder IDs', () => {
    const reminderId = reminderNotifId('any-uuid', 3);
    const startId = blockStartNotifId('any-uuid', 3);
    const endId = blockEndNotifId('any-uuid', 3);
    expect(startId).not.toBe(reminderId);
    expect(endId).not.toBe(reminderId);
  });

  it('stays within 32-bit signed positive range', () => {
    for (let d = 0; d < 7; d++) {
      const s = blockStartNotifId('550e8400-e29b-41d4-a716-446655440000', d);
      const e = blockEndNotifId('550e8400-e29b-41d4-a716-446655440000', d);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(2 ** 31);
      expect(e).toBeGreaterThan(0);
      expect(e).toBeLessThan(2 ** 31);
    }
  });
});

describe('scheduleBlockNotifsNative — recurring block', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00')); // Wed
  });

  it('schedules a start + end notification for each day in the block', async () => {
    const b = makeBlock({ days: [0, 2, 4] }); // Mon, Wed, Fri
    await scheduleBlockNotifsNative(b);
    expect(mockSchedule).toHaveBeenCalledOnce();
    const notifs = mockSchedule.mock.calls[0][0].notifications;
    expect(notifs).toHaveLength(6); // 3 days × (start + end)
  });

  it('cancels prior slots before scheduling', async () => {
    await scheduleBlockNotifsNative(makeBlock({ days: [2] }));
    expect(mockCancel).toHaveBeenCalledOnce();
  });

  it('start notification fires 5 minutes before the block start time', async () => {
    const b = makeBlock({ days: [2], start: '09:00' }); // Wed at 9:00
    await scheduleBlockNotifsNative(b);
    const notifs = mockSchedule.mock.calls[0][0].notifications;
    const startNotif = notifs.find((n: { id: number }) => n.id === blockStartNotifId('b-1', 2));
    const fireAt = startNotif.schedule.at as Date;
    expect(fireAt.getHours()).toBe(8);
    expect(fireAt.getMinutes()).toBe(55);
  });

  it('end notification fires at block start + duration', async () => {
    const b = makeBlock({ days: [2], start: '09:00', duration: 90 });
    await scheduleBlockNotifsNative(b);
    const notifs = mockSchedule.mock.calls[0][0].notifications;
    const endNotif = notifs.find((n: { id: number }) => n.id === blockEndNotifId('b-1', 2));
    const fireAt = endNotif.schedule.at as Date;
    expect(fireAt.getHours()).toBe(10);
    expect(fireAt.getMinutes()).toBe(30);
  });

  it('start title says "Starting soon" with the block label', async () => {
    const b = makeBlock({ days: [2], title: 'Deep work' });
    await scheduleBlockNotifsNative(b);
    const startNotif = mockSchedule.mock.calls[0][0].notifications
      .find((n: { id: number }) => n.id === blockStartNotifId('b-1', 2));
    expect(startNotif.title).toMatch(/starting soon/i);
    expect(startNotif.title).toContain('Deep work');
  });

  it('falls back to type label when block.title is empty', async () => {
    const b = makeBlock({ days: [2], title: '', type: 'rest' });
    await scheduleBlockNotifsNative(b);
    const startNotif = mockSchedule.mock.calls[0][0].notifications
      .find((n: { id: number }) => n.id === blockStartNotifId('b-1', 2));
    expect(startNotif.title.toLowerCase()).toContain('rest');
  });

  it('end title references the block ending', async () => {
    const b = makeBlock({ days: [2], title: 'Deep work' });
    await scheduleBlockNotifsNative(b);
    const endNotif = mockSchedule.mock.calls[0][0].notifications
      .find((n: { id: number }) => n.id === blockEndNotifId('b-1', 2));
    expect(endNotif.title).toContain('Deep work');
    expect(endNotif.title.toLowerCase()).toMatch(/wrap|end|done|finish/);
  });

  it('pushes today\'s start+end to next week when suppressed', async () => {
    const b = makeBlock({ days: [2], start: '09:00', duration: 60 });
    await scheduleBlockNotifsNative(b, true);
    const notifs = mockSchedule.mock.calls[0][0].notifications;
    // both should be on the 20th (next Wed), not the 13th (today)
    for (const n of notifs) {
      expect((n.schedule.at as Date).getDate()).toBe(20);
    }
  });

  it('sets smallIcon and allowWhileIdle on every notification', async () => {
    await scheduleBlockNotifsNative(makeBlock({ days: [0, 2] }));
    const notifs = mockSchedule.mock.calls[0][0].notifications;
    for (const n of notifs) {
      expect(n.smallIcon).toBe('ic_stat_icon');
      expect(n.schedule.allowWhileIdle).toBe(true);
    }
  });
});

describe('scheduleBlockNotifsNative — one-off block', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00')); // Wed
  });

  it('schedules a single start + end pair for a future-dated one-off', async () => {
    const b = makeBlock({ days: [], date: '2026-05-15', start: '10:00', duration: 60 });
    await scheduleBlockNotifsNative(b);
    const notifs = mockSchedule.mock.calls[0][0].notifications;
    expect(notifs).toHaveLength(2);
    const startAt = notifs.find((n: { id: number }) => n.id === blockStartNotifId('b-1', 0)).schedule.at as Date;
    expect(startAt.getFullYear()).toBe(2026);
    expect(startAt.getMonth()).toBe(4);
    expect(startAt.getDate()).toBe(15);
    expect(startAt.getHours()).toBe(9);
    expect(startAt.getMinutes()).toBe(55);
  });

  it('does NOT schedule a one-off block whose start time has already passed', async () => {
    const b = makeBlock({ days: [], date: '2026-05-13', start: '06:00', duration: 60 });
    await scheduleBlockNotifsNative(b);
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('scheduleBlockNotifsNative — no-ops', () => {
  it('no-ops on a pool block (empty start)', async () => {
    await scheduleBlockNotifsNative(makeBlock({ start: '', days: [] }));
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('no-ops on a recurring block with empty days', async () => {
    await scheduleBlockNotifsNative(makeBlock({ days: [], date: null }));
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('no-ops on a block already marked done', async () => {
    await scheduleBlockNotifsNative(makeBlock({ days: [2], status: 'done' }));
    // For recurring blocks "done" applies to a specific date — scheduling still
    // covers future days. Caller passes suppressedToday=true to skip today.
    // So "done" alone (without per-date context) should NOT block scheduling
    // future days. Verify by checking that scheduling happens.
    expect(mockSchedule).toHaveBeenCalledOnce();
  });

  it('no-ops on a one-off block already marked done', async () => {
    await scheduleBlockNotifsNative(makeBlock({
      days: [], date: '2026-05-15', start: '10:00', status: 'done',
    }));
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('no-ops on a one-off block already marked skipped', async () => {
    await scheduleBlockNotifsNative(makeBlock({
      days: [], date: '2026-05-15', start: '10:00', status: 'skipped',
    }));
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('cancelBlockNotifsNative', () => {
  it('cancels all 7 day slots × 2 (start + end)', async () => {
    await cancelBlockNotifsNative('b-1');
    expect(mockCancel).toHaveBeenCalledOnce();
    const arg = mockCancel.mock.calls[0][0];
    expect(arg.notifications).toHaveLength(14);
    const ids = arg.notifications.map((n: { id: number }) => n.id);
    expect(new Set(ids).size).toBe(14);
  });
});

describe('refreshBlockTodayNative', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00')); // Wed dayIdx 2
  });

  it('reschedules today when not suppressed and today is in days', async () => {
    const b = makeBlock({ days: [2], start: '09:00', duration: 60 });
    await refreshBlockTodayNative(b, false);
    const notifs = mockSchedule.mock.calls[0][0].notifications;
    expect(notifs).toHaveLength(2);
    for (const n of notifs) {
      expect((n.schedule.at as Date).getDate()).toBe(13);
    }
  });

  it('pushes today\'s start+end to next week when suppressed', async () => {
    const b = makeBlock({ days: [2], start: '09:00', duration: 60 });
    await refreshBlockTodayNative(b, true);
    const notifs = mockSchedule.mock.calls[0][0].notifications;
    for (const n of notifs) {
      expect((n.schedule.at as Date).getDate()).toBe(20);
    }
  });

  it('no-ops when today is not in the block\'s days', async () => {
    const b = makeBlock({ days: [0, 1] }); // Mon, Tue — not Wed
    await refreshBlockTodayNative(b, false);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('no-ops on a one-off block (refresh is for recurring suppression)', async () => {
    const b = makeBlock({ days: [], date: '2026-05-13', start: '09:00' });
    await refreshBlockTodayNative(b, true);
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('refillBlockNotifsNative', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-05-13T07:00:00'));
  });

  it('only schedules block slots that are not already pending', async () => {
    const b = makeBlock({ days: [0, 2], start: '09:00', duration: 60 });
    mockGetPending.mockResolvedValue({
      notifications: [
        // Mon start + end already pending; Wed missing
        { id: blockStartNotifId('b-1', 0) },
        { id: blockEndNotifId('b-1', 0) },
      ],
    });
    await refillBlockNotifsNative([b], () => false);
    const notifs = mockSchedule.mock.calls[0][0].notifications;
    expect(notifs).toHaveLength(2); // just Wed start + end
  });

  it('honors today\'s suppression when refilling', async () => {
    const b = makeBlock({ days: [2], start: '09:00', duration: 60 });
    mockGetPending.mockResolvedValue({ notifications: [] });
    await refillBlockNotifsNative([b], () => true);
    const notifs = mockSchedule.mock.calls[0][0].notifications;
    for (const n of notifs) {
      expect((n.schedule.at as Date).getDate()).toBe(20);
    }
  });

  it('does not call schedule when nothing is missing', async () => {
    const b = makeBlock({ days: [2], start: '09:00', duration: 60 });
    mockGetPending.mockResolvedValue({
      notifications: [
        { id: blockStartNotifId('b-1', 2) },
        { id: blockEndNotifId('b-1', 2) },
      ],
    });
    await refillBlockNotifsNative([b], () => false);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('skips pool blocks and recurring blocks with no days', async () => {
    await refillBlockNotifsNative(
      [makeBlock({ start: '', days: [] }), makeBlock({ days: [] })],
      () => false,
    );
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

// ─── Summary notifications ───────────────────────────────────────────

describe('scheduleDailyNudgeNative', () => {
  it('schedules at 20:00 today when called before 8 PM', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await scheduleDailyNudgeNative();
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    const at = notif.schedule.at as Date;
    expect(at.getDate()).toBe(13);
    expect(at.getHours()).toBe(20);
    expect(at.getMinutes()).toBe(0);
  });

  it('schedules at 20:00 tomorrow when called after 8 PM', async () => {
    vi.setSystemTime(new Date('2026-05-13T21:00:00'));
    await scheduleDailyNudgeNative();
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    const at = notif.schedule.at as Date;
    expect(at.getDate()).toBe(14);
    expect(at.getHours()).toBe(20);
  });

  it('uses reserved id 4', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await scheduleDailyNudgeNative();
    expect(mockSchedule.mock.calls[0][0].notifications[0].id).toBe(4);
  });

  it('cancels prior id before scheduling', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await scheduleDailyNudgeNative();
    expect(mockCancel).toHaveBeenCalled();
    expect(mockCancel.mock.calls[0][0]).toEqual({ notifications: [{ id: 4 }] });
  });

  it('sets smallIcon and allowWhileIdle', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await scheduleDailyNudgeNative();
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect(notif.smallIcon).toBe('ic_stat_icon');
    expect(notif.schedule.allowWhileIdle).toBe(true);
  });
});

describe('scheduleMorningBriefNative', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-05-13T05:00:00')); // Wed early morning
  });

  it('schedules 15 min before the first block of the day', async () => {
    const blocks = [
      makeBlock({ id: 'b1', days: [2], start: '09:30', duration: 60 }),
      makeBlock({ id: 'b2', days: [2], start: '14:00', duration: 60 }),
    ];
    await scheduleMorningBriefNative(blocks);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    const at = notif.schedule.at as Date;
    expect(at.getHours()).toBe(9);
    expect(at.getMinutes()).toBe(15);
  });

  it('clamps the fire time to 7 AM minimum', async () => {
    const blocks = [makeBlock({ id: 'b1', days: [2], start: '07:00', duration: 60 })];
    await scheduleMorningBriefNative(blocks);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    const at = notif.schedule.at as Date;
    expect(at.getHours()).toBe(7);
    expect(at.getMinutes()).toBe(0);
  });

  it('schedules tomorrow when today\'s briefing window has passed', async () => {
    vi.setSystemTime(new Date('2026-05-13T15:00:00')); // afternoon
    const blocks = [makeBlock({ id: 'b1', days: [2, 3], start: '09:00', duration: 60 })];
    await scheduleMorningBriefNative(blocks);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    const at = notif.schedule.at as Date;
    expect(at.getDate()).toBe(14); // Thu
  });

  it('uses reserved id 2 and cancels prior', async () => {
    const blocks = [makeBlock({ id: 'b1', days: [2], start: '09:30', duration: 60 })];
    await scheduleMorningBriefNative(blocks);
    expect(mockCancel.mock.calls[0][0]).toEqual({ notifications: [{ id: 2 }] });
    expect(mockSchedule.mock.calls[0][0].notifications[0].id).toBe(2);
  });

  it('no-ops when no scheduled blocks exist within the next 7 days', async () => {
    await scheduleMorningBriefNative([makeBlock({ start: '', days: [] })]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('skips blocks that are pool items (no start)', async () => {
    const blocks = [
      makeBlock({ id: 'b1', start: '', days: [] }),
      makeBlock({ id: 'b2', days: [2], start: '10:00', duration: 60 }),
    ];
    await scheduleMorningBriefNative(blocks);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    const at = notif.schedule.at as Date;
    expect(at.getHours()).toBe(9);
    expect(at.getMinutes()).toBe(45);
  });
});

describe('scheduleMiddayPulseNative', () => {
  it('schedules at 13:00 today when called before 1 PM, with pending blocks', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    const blocks = [makeBlock({ id: 'b1', days: [2], start: '15:00', duration: 60 })];
    await scheduleMiddayPulseNative(blocks, false);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    const at = notif.schedule.at as Date;
    expect(at.getHours()).toBe(13);
    expect(at.getMinutes()).toBe(0);
  });

  it('schedules tomorrow when called after 1 PM', async () => {
    vi.setSystemTime(new Date('2026-05-13T14:00:00'));
    const blocks = [makeBlock({ id: 'b1', days: [3], start: '15:00', duration: 60 })];
    await scheduleMiddayPulseNative(blocks, false);
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect((notif.schedule.at as Date).getDate()).toBe(14);
  });

  it('no-ops when the user has recently logged energy', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    const blocks = [makeBlock({ id: 'b1', days: [2], start: '15:00', duration: 60 })];
    await scheduleMiddayPulseNative(blocks, true);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('cancels its slot even when suppressed (so a prior scheduled pulse doesn\'t still fire)', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await scheduleMiddayPulseNative([], true);
    expect(mockCancel).toHaveBeenCalled();
    expect(mockCancel.mock.calls[0][0]).toEqual({ notifications: [{ id: 3 }] });
  });

  it('no-ops when no blocks exist (nothing pending to nudge about)', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await scheduleMiddayPulseNative([], false);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('uses reserved id 3', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    const blocks = [makeBlock({ id: 'b1', days: [2], start: '15:00', duration: 60 })];
    await scheduleMiddayPulseNative(blocks, false);
    expect(mockSchedule.mock.calls[0][0].notifications[0].id).toBe(3);
  });
});

describe('schedulePoolNudgeNative', () => {
  it('schedules at 14:00 when there are pool items, no scheduled blocks today, and not recently active', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await schedulePoolNudgeNative({
      hasPoolItems: true,
      hasScheduledBlocksToday: false,
      recentlyActive: false,
    });
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    const at = notif.schedule.at as Date;
    expect(at.getHours()).toBe(14);
    expect(at.getMinutes()).toBe(0);
  });

  it('no-ops when there are no pool items', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await schedulePoolNudgeNative({
      hasPoolItems: false,
      hasScheduledBlocksToday: false,
      recentlyActive: false,
    });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('no-ops when there are scheduled blocks today (start/end nudges already cover engagement)', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await schedulePoolNudgeNative({
      hasPoolItems: true,
      hasScheduledBlocksToday: true,
      recentlyActive: false,
    });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('no-ops when the user has been recently active', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await schedulePoolNudgeNative({
      hasPoolItems: true,
      hasScheduledBlocksToday: false,
      recentlyActive: true,
    });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('schedules tomorrow when called after 2 PM', async () => {
    vi.setSystemTime(new Date('2026-05-13T15:00:00'));
    await schedulePoolNudgeNative({
      hasPoolItems: true,
      hasScheduledBlocksToday: false,
      recentlyActive: false,
    });
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    expect((notif.schedule.at as Date).getDate()).toBe(14);
  });

  it('uses reserved id 5', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await schedulePoolNudgeNative({
      hasPoolItems: true,
      hasScheduledBlocksToday: false,
      recentlyActive: false,
    });
    expect(mockSchedule.mock.calls[0][0].notifications[0].id).toBe(5);
  });
});

describe('scheduleWeeklyRecapNative', () => {
  it('schedules on the next Sunday at 19:00', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00')); // Wed
    await scheduleWeeklyRecapNative();
    const notif = mockSchedule.mock.calls[0][0].notifications[0];
    const at = notif.schedule.at as Date;
    expect(at.getDay()).toBe(0); // Sunday
    expect(at.getDate()).toBe(17);
    expect(at.getHours()).toBe(19);
  });

  it('on Sunday before 7 PM, schedules for today', async () => {
    vi.setSystemTime(new Date('2026-05-17T10:00:00')); // Sun
    await scheduleWeeklyRecapNative();
    const at = mockSchedule.mock.calls[0][0].notifications[0].schedule.at as Date;
    expect(at.getDate()).toBe(17);
    expect(at.getHours()).toBe(19);
  });

  it('on Sunday after 7 PM, schedules for next Sunday', async () => {
    vi.setSystemTime(new Date('2026-05-17T20:00:00')); // Sun evening
    await scheduleWeeklyRecapNative();
    const at = mockSchedule.mock.calls[0][0].notifications[0].schedule.at as Date;
    expect(at.getDate()).toBe(24);
  });

  it('uses reserved id 6', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'));
    await scheduleWeeklyRecapNative();
    expect(mockSchedule.mock.calls[0][0].notifications[0].id).toBe(6);
  });
});

describe('cancelSummaryNotifsNative', () => {
  it('cancels all 5 summary IDs in one call', async () => {
    await cancelSummaryNotifsNative();
    expect(mockCancel).toHaveBeenCalledOnce();
    const ids = mockCancel.mock.calls[0][0].notifications
      .map((n: { id: number }) => n.id)
      .sort((a: number, b: number) => a - b);
    expect(ids).toEqual([2, 3, 4, 5, 6]);
  });
});
