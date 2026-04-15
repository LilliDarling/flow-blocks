import { supabase } from './supabase.js';
import {
  FlowBlock, DoneItem, PomoMode, PomoSettings, PomoSession, PomoSessionRow,
  BlockStatus, CompletionRow, EnergyLogRow,
  Reminder, ReminderRow, ReminderCompletionRow, ReminderTimeSuggestion, reminderFromRow,
  blockFromRow, doneItemFromRow, getTodayDate, getDateForDayIndex, valueToTier,
} from './utils.js';
import { emit, diff, MutationSource } from './events.js';
import {
  CalendarEvent, CalendarConnection,
  loadConnections, fetchAllEvents, disconnectCalendar, checkOAuthRedirect,
} from './calendar/index.js';

export interface PomoState {
  mode: PomoMode;
  running: boolean;
  secondsLeft: number;
  totalSeconds: number;
  interval: ReturnType<typeof setInterval> | null;
  completedPomos: number;
  focusMinutes: number;
  streak: number;
  soundOn: boolean;
  settings: PomoSettings;
}

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function fromMin(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

class AppState {
  blocks: FlowBlock[] = [];
  doneItems: DoneItem[] = [];
  completions: Map<string, BlockStatus> = new Map(); // "blockId_YYYY-MM-DD" -> status
  energy = 5;
  energyLogs: EnergyLogRow[] = [];
  calendarConnections: CalendarConnection[] = [];
  calendarEvents: CalendarEvent[] = [];
  weekCalendarEvents: Map<string, CalendarEvent[]> = new Map(); // "YYYY-MM-DD" -> events
  hiddenCalendarEventIds: Set<string> = new Set(); // events hidden from today's view
  calSyncSeenIds: Set<string> = new Set(); // event IDs already prompted for buffer (synced via Supabase)
  pomoSessions: PomoSession[] = [];
  reminders: Reminder[] = [];
  reminderCompletions: Set<string> = new Set(); // reminder IDs completed today
  reminderSkips: Set<string> = new Set(); // reminder IDs skipped today (persisted)
  reminderCompletionHistory: ReminderCompletionRow[] = []; // last 7 days
  dismissedSuggestions: Set<string> = new Set(); // reminder IDs whose suggestions were dismissed this session
  editingIndex = -1;
  selectedType = '';
  selectedDays: number[] = [];
  userId: string | null = null;

  pomo: PomoState = {
    mode: 'focus',
    running: false,
    secondsLeft: 25 * 60,
    totalSeconds: 25 * 60,
    interval: null,
    completedPomos: 0,
    focusMinutes: 0,
    streak: 0,
    soundOn: true,
    settings: { focus: 25, short: 5, long: 15, longAfter: 4 },
  };

  async load(userId: string): Promise<void> {
    this.userId = userId;

    // Fetch blocks: all recurring + one-off blocks from last 7 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    const { data: blockRows } = await supabase
      .from('blocks')
      .select('*')
      .eq('user_id', userId)
      .or(`block_date.is.null,block_date.gte.${cutoffDate}`)
      .order('start_time');
    this.blocks = (blockRows || []).map(blockFromRow);

    // Fetch today's completions for recurring blocks
    const today = getTodayDate();
    const recurringIds = this.blocks.filter(b => !b.date && b.id).map(b => b.id!);
    if (recurringIds.length > 0) {
      const { data: compRows } = await supabase
        .from('block_completions')
        .select('*')
        .in('block_id', recurringIds)
        .eq('completion_date', today);
      this.completions.clear();
      for (const row of (compRows || []) as CompletionRow[]) {
        this.completions.set(`${row.block_id}_${row.completion_date}`, row.status as BlockStatus);
      }
    }

    // Fetch energy logs (last 14 days for analytics)
    await this.loadEnergyLogs();

    // Restore the most recent energy value
    if (this.energyLogs.length > 0) {
      this.energy = this.energyLogs[this.energyLogs.length - 1].value;
    }

    // Load calendar connections + events
    this.loadHiddenCalendarEvents();
    await this.loadCalendar();

    // Fetch done items (today only)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { data: doneRows } = await supabase
      .from('done_items')
      .select('*')
      .eq('user_id', userId)
      .gte('created_at', todayStart.toISOString());
    this.doneItems = (doneRows || []).map(doneItemFromRow);

    // Fetch pomo settings
    const { data: pomoRow } = await supabase
      .from('pomo_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (pomoRow) {
      this.pomo.completedPomos = pomoRow.completed_pomos;
      this.pomo.focusMinutes = pomoRow.focus_minutes;
      this.pomo.streak = pomoRow.streak;
      this.pomo.soundOn = pomoRow.sound_on;
      this.pomo.settings = {
        focus: pomoRow.focus_duration,
        short: pomoRow.short_duration,
        long: pomoRow.long_duration,
        longAfter: pomoRow.long_after,
      };
    }

    // Fetch today's pomo sessions (from all devices)
    await this.loadPomoSessions();

    // Fetch reminders + today's completions
    await this.loadReminders();
  }

  /** Lightweight re-sync of volatile data when the app regains focus.
   *  Skips heavy one-time setup (calendar OAuth, pomo settings). */
  async refresh(): Promise<void> {
    if (!this.userId) return;
    const today = getTodayDate();

    // Re-fetch blocks
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const { data: blockRows } = await supabase
      .from('blocks')
      .select('*')
      .eq('user_id', this.userId)
      .or(`block_date.is.null,block_date.gte.${cutoffDate}`)
      .order('start_time');
    this.blocks = (blockRows || []).map(blockFromRow);

    // Re-fetch completions
    const recurringIds = this.blocks.filter(b => !b.date && b.id).map(b => b.id!);
    if (recurringIds.length > 0) {
      const { data: compRows } = await supabase
        .from('block_completions')
        .select('*')
        .in('block_id', recurringIds)
        .eq('completion_date', today);
      this.completions.clear();
      for (const row of (compRows || []) as CompletionRow[]) {
        this.completions.set(`${row.block_id}_${row.completion_date}`, row.status as BlockStatus);
      }
    }

    // Re-fetch energy
    await this.loadEnergyLogs();
    if (this.energyLogs.length > 0) {
      this.energy = this.energyLogs[this.energyLogs.length - 1].value;
    }

    // Re-fetch done items
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { data: doneRows } = await supabase
      .from('done_items')
      .select('*')
      .eq('user_id', this.userId)
      .gte('created_at', todayStart.toISOString());
    this.doneItems = (doneRows || []).map(doneItemFromRow);

    // Re-fetch reminders + completions/skips
    await this.loadReminders();

    // Re-fetch pomo sessions
    await this.loadPomoSessions();
  }

  // --- Block CRUD ---

  async addBlock(block: FlowBlock, source: MutationSource = 'manual'): Promise<void> {
    const row: Record<string, unknown> = {
      user_id: this.userId,
      type: block.type,
      title: block.title,
      menu: block.menu,
      start_time: block.start || null, // null = pool (unscheduled)
      duration: block.duration,
      days: block.days,
      block_date: block.date,
      status: block.status,
    };
    if (block.linked_event_id) row.linked_event_id = block.linked_event_id;

    const { data, error } = await supabase
      .from('blocks')
      .insert(row)
      .select()
      .single();

    if (!error && data) {
      this.blocks.push(blockFromRow(data));
      emit({
        type: 'block.created',
        entity_id: data.id,
        entity_type: 'block',
        payload: {
          type: block.type, title: block.title, menu: block.menu,
          start_time: block.start, duration: block.duration,
          days: block.days, block_date: block.date,
          linked_event_id: block.linked_event_id, source,
        },
      });
    }
    this.showSaveBanner();
  }

  async updateBlock(index: number, block: FlowBlock, source: MutationSource = 'manual'): Promise<void> {
    const existing = this.blocks[index];
    if (!existing?.id) return;

    const before = {
      type: existing.type, title: existing.title, menu: existing.menu,
      start: existing.start, duration: existing.duration,
      days: existing.days, date: existing.date, status: existing.status,
    };

    const { data, error } = await supabase
      .from('blocks')
      .update({
        type: block.type,
        title: block.title,
        menu: block.menu,
        start_time: block.start || null,
        duration: block.duration,
        days: block.days,
        block_date: block.date,
        status: block.status,
      })
      .eq('id', existing.id)
      .select()
      .single();

    if (!error && data) {
      this.blocks[index] = blockFromRow(data);
      const after = {
        type: block.type, title: block.title, menu: block.menu,
        start: block.start, duration: block.duration,
        days: block.days, date: block.date, status: block.status,
      };
      const changes = diff(before as Record<string, unknown>, after as Record<string, unknown>);
      if (Object.keys(changes).length > 0) {
        emit({
          type: 'block.updated',
          entity_id: existing.id,
          entity_type: 'block',
          payload: { changes, source },
        });
      }
    }
    this.showSaveBanner();
  }

  async deleteBlock(index: number, source: MutationSource = 'manual'): Promise<void> {
    const existing = this.blocks[index];
    if (!existing?.id) return;

    await supabase.from('blocks').delete().eq('id', existing.id);
    emit({
      type: 'block.deleted',
      entity_id: existing.id,
      entity_type: 'block',
      payload: {
        block_type: existing.type,
        title: existing.title,
        reason: source === 'calendar_reconcile' ? 'calendar_reconcile' : 'user',
      },
    });
    this.blocks.splice(index, 1);
    this.showSaveBanner();
  }

  /** Get the effective status for a block on a given date. */
  getEffectiveStatus(block: FlowBlock, date: string): BlockStatus {
    // One-off blocks use their own status field directly
    if (block.date) return block.status;
    // Recurring blocks check the completions map
    const key = `${block.id}_${date}`;
    return this.completions.get(key) || 'pending';
  }

  async updateBlockStatus(index: number, status: BlockStatus, completedAt?: Date, menuItemsDone?: string[]): Promise<void> {
    const existing = this.blocks[index];
    if (!existing?.id) return;
    const today = getTodayDate();

    if (existing.date) {
      // One-off block: update the block row directly (original behavior)
      await supabase.from('blocks').update({ status }).eq('id', existing.id);
      this.blocks[index].status = status;
    } else {
      // Recurring block: upsert into block_completions for today
      const row: Record<string, unknown> = {
        block_id: existing.id,
        completion_date: today,
        status,
      };
      if (completedAt) row.completed_at = completedAt.toISOString();
      await supabase
        .from('block_completions')
        .upsert(row, { onConflict: 'block_id,completion_date' });
      this.completions.set(`${existing.id}_${today}`, status);
    }

    // Emit status event
    const date = existing.date || today;

    if (status === 'done') {
      emit({
        type: 'block.completed',
        entity_id: existing.id,
        entity_type: 'block',
        payload: {
          date, block_type: existing.type, title: existing.title,
          ...(completedAt ? { completed_at: completedAt.toISOString() } : {}),
          ...(menuItemsDone && menuItemsDone.length > 0 ? { menu_items_done: menuItemsDone } : {}),
        },
      });
    } else if (status === 'skipped') {
      emit({
        type: 'block.skipped',
        entity_id: existing.id,
        entity_type: 'block',
        payload: { date, block_type: existing.type, title: existing.title },
      });
    } else {
      emit({
        type: 'block.dismissed',
        entity_id: existing.id,
        entity_type: 'block',
        payload: { date, block_type: existing.type, title: existing.title },
      });
    }
  }

  // --- Calendar ---

  async loadCalendar(): Promise<void> {
    if (!this.userId) return;
    this.calendarConnections = await loadConnections(this.userId);
    if (this.calendarConnections.length > 0) {
      const today = getTodayDate();
      this.calendarEvents = await fetchAllEvents(this.calendarConnections, today);
      await this.loadCalSyncSeen();
      await this.reconcileBuffers();
      // Fetch events for the full week (for week view)
      this.loadWeekCalendar();
    }
  }

  /** Fetch calendar events for every day of the current week. */
  async loadWeekCalendar(): Promise<void> {
    if (this.calendarConnections.length === 0) return;
    this.weekCalendarEvents.clear();
    const fetches = Array.from({ length: 7 }, (_, i) => {
      const date = getDateForDayIndex(i);
      return fetchAllEvents(this.calendarConnections, date).then(events => {
        this.weekCalendarEvents.set(date, events);
      });
    });
    await Promise.all(fetches);
  }

  /** Reconcile linked buffer blocks against current calendar events.
   *  - Delete buffers whose linked event no longer exists (deleted from calendar)
   *  - Update buffer times if the linked event's time has changed
   */
  private async reconcileBuffers(): Promise<void> {
    const today = getTodayDate();
    const eventMap = new Map(this.calendarEvents.map(e => [e.id, e]));

    // Walk backwards so splicing doesn't shift indices
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      if (!block.linked_event_id || block.date !== today) continue;

      const event = eventMap.get(block.linked_event_id);

      if (!event) {
        // Event was deleted from calendar — remove the buffer
        await this.deleteBlock(i, 'calendar_reconcile');
        continue;
      }

      // Event still exists — check if its time changed and update buffer accordingly
      const evStartMin = toMin(event.start);
      const evEndMin = toMin(event.end);
      const isBefore = block.title.startsWith('Buffer before');
      const expectedStart = isBefore
        ? fromMin(evStartMin - block.duration)
        : fromMin(evEndMin);

      if (block.start !== expectedStart) {
        await this.updateBlock(i, { ...block, start: expectedStart }, 'calendar_reconcile');
      }
    }
  }

  async checkCalendarRedirect(): Promise<boolean> {
    if (!this.userId) return false;
    const conn = await checkOAuthRedirect(this.userId);
    if (conn) {
      this.calendarConnections.push(conn);
      emit({
        type: 'calendar.connected',
        entity_id: conn.id,
        entity_type: null,
        payload: { provider: conn.provider, display_name: conn.display_name },
      });
      await this.loadCalendar();
      return true;
    }
    return false;
  }

  async removeCalendarConnection(connectionId: string): Promise<void> {
    const conn = this.calendarConnections.find(c => c.id === connectionId);
    await disconnectCalendar(connectionId);
    this.calendarConnections = this.calendarConnections.filter(c => c.id !== connectionId);
    if (conn) {
      emit({
        type: 'calendar.disconnected',
        entity_id: connectionId,
        entity_type: null,
        payload: { provider: conn.provider },
      });
    }
    // Re-fetch events without that connection
    const today = getTodayDate();
    this.calendarEvents = this.calendarConnections.length > 0
      ? await fetchAllEvents(this.calendarConnections, today)
      : [];
  }

  // --- Hidden calendar events ---

  hideCalendarEvent(eventId: string): void {
    this.hiddenCalendarEventIds.add(eventId);
    const key = `hidden_cal_${getTodayDate()}`;
    localStorage.setItem(key, JSON.stringify([...this.hiddenCalendarEventIds]));
  }

  loadHiddenCalendarEvents(): void {
    const today = getTodayDate();
    const key = `hidden_cal_${today}`;
    const stored = localStorage.getItem(key);
    this.hiddenCalendarEventIds = new Set(stored ? JSON.parse(stored) : []);
    // Clean up keys from prior days
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('hidden_cal_') && k !== key) localStorage.removeItem(k);
    }
  }

  // --- Calendar sync seen (cross-device) ---

  async loadCalSyncSeen(): Promise<void> {
    if (!this.userId) return;
    const today = getTodayDate();
    const { data } = await supabase
      .from('cal_event_seen')
      .select('event_id')
      .eq('user_id', this.userId)
      .eq('seen_date', today);
    this.calSyncSeenIds = new Set((data || []).map((r: { event_id: string }) => r.event_id));
  }

  async markCalEventsSeen(eventIds: string[]): Promise<void> {
    if (!this.userId) return;
    const today = getTodayDate();
    const newIds = eventIds.filter(id => !this.calSyncSeenIds.has(id));
    if (newIds.length === 0) return;
    await supabase.from('cal_event_seen').upsert(
      newIds.map(id => ({ user_id: this.userId, event_id: id, seen_date: today })),
      { onConflict: 'user_id,event_id,seen_date' },
    );
    for (const id of newIds) this.calSyncSeenIds.add(id);
  }

  // --- Energy logging ---

  async logEnergy(value: number): Promise<void> {
    const { data } = await supabase
      .from('energy_logs')
      .insert({ user_id: this.userId, value })
      .select()
      .single();
    if (data) {
      this.energyLogs.push(data as EnergyLogRow);
      emit({
        type: 'energy.logged',
        entity_type: null,
        payload: { value, tier: valueToTier(value) },
      });
    }
  }

  /** Fetch the most recent energy log to sync across tabs/devices. */
  async fetchLatestEnergyLog(): Promise<EnergyLogRow | null> {
    const { data } = await supabase
      .from('energy_logs')
      .select('*')
      .eq('user_id', this.userId)
      .order('logged_at', { ascending: false })
      .limit(1)
      .single();
    return (data as EnergyLogRow) || null;
  }

  async loadEnergyLogs(days: number = 14): Promise<void> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const { data } = await supabase
      .from('energy_logs')
      .select('*')
      .eq('user_id', this.userId)
      .gte('logged_at', since.toISOString())
      .order('logged_at');
    this.energyLogs = (data || []) as EnergyLogRow[];
  }

  // --- Done items ---

  async addDoneItem(text: string, completedAt?: Date, sourceBlockId?: string): Promise<void> {
    const time = (completedAt ?? new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const { data } = await supabase
      .from('done_items')
      .insert({ user_id: this.userId, text, time })
      .select()
      .single();

    if (data) {
      this.doneItems.push(doneItemFromRow(data));
      emit({
        type: 'done_item.created',
        entity_id: data.id,
        entity_type: null,
        payload: { text, time, ...(sourceBlockId && { source_block_id: sourceBlockId }) },
      });
    }
  }

  // --- Pomo ---

  async savePomo(): Promise<void> {
    const { settings, completedPomos, focusMinutes, streak, soundOn } = this.pomo;
    await supabase
      .from('pomo_settings')
      .upsert({
        user_id: this.userId,
        completed_pomos: completedPomos,
        focus_minutes: focusMinutes,
        streak,
        focus_duration: settings.focus,
        short_duration: settings.short,
        long_duration: settings.long,
        long_after: settings.longAfter,
        sound_on: soundOn,
      });
  }

  async loadPomoSessions(): Promise<void> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { data } = await supabase
      .from('pomo_sessions')
      .select('*')
      .eq('user_id', this.userId)
      .gte('completed_at', todayStart.toISOString())
      .order('completed_at');
    this.pomoSessions = (data || []).map((row: PomoSessionRow) => ({
      id: row.id,
      task: row.task,
      duration: row.duration,
      distractions: row.distractions,
      completed_at: row.completed_at,
    }));
  }

  async addPomoSession(session: { task: string; duration: number; distractions: number }): Promise<PomoSession | null> {
    const { data } = await supabase
      .from('pomo_sessions')
      .insert({
        user_id: this.userId,
        task: session.task,
        duration: session.duration,
        distractions: session.distractions,
      })
      .select()
      .single();

    if (data) {
      const row = data as PomoSessionRow;
      const entry: PomoSession = {
        id: row.id,
        task: row.task,
        duration: row.duration,
        distractions: row.distractions,
        completed_at: row.completed_at,
      };
      this.pomoSessions.push(entry);
      emit({
        type: 'pomo.session_completed',
        entity_id: row.id,
        entity_type: 'pomo',
        payload: { task: session.task, duration: session.duration, distractions: session.distractions },
      });
      return entry;
    }
    return null;
  }

  // --- Reminders ---

  async loadReminders(): Promise<void> {
    const { data: reminderRows } = await supabase
      .from('reminders')
      .select('*')
      .eq('user_id', this.userId)
      .order('reminder_time');
    this.reminders = (reminderRows || []).map((r: ReminderRow) => reminderFromRow(r));

    // Load today's completions and skips
    const today = getTodayDate();
    const reminderIds = this.reminders.filter(r => r.id).map(r => r.id!);
    this.reminderCompletions.clear();
    this.reminderSkips.clear();
    if (reminderIds.length > 0) {
      const { data: compRows } = await supabase
        .from('reminder_completions')
        .select('*')
        .in('reminder_id', reminderIds)
        .eq('completion_date', today);
      for (const row of (compRows || []) as ReminderCompletionRow[]) {
        this.reminderCompletions.add(row.reminder_id);
      }

      const { data: skipRows } = await supabase
        .from('reminder_skips')
        .select('reminder_id')
        .in('reminder_id', reminderIds)
        .eq('skip_date', today);
      for (const row of (skipRows || []) as { reminder_id: string }[]) {
        this.reminderSkips.add(row.reminder_id);
      }
    }

    // Load 7-day completion history for time suggestions
    await this.loadReminderCompletionHistory();
  }

  async addReminder(reminder: Reminder): Promise<void> {
    const { data, error } = await supabase
      .from('reminders')
      .insert({
        user_id: this.userId,
        name: reminder.name,
        reminder_time: reminder.time,
        days: reminder.days,
        icon: reminder.icon,
      })
      .select()
      .single();

    if (!error && data) {
      this.reminders.push(reminderFromRow(data));
      emit({
        type: 'reminder.created',
        entity_id: data.id,
        entity_type: 'reminder',
        payload: { name: reminder.name, time: reminder.time, days: reminder.days, icon: reminder.icon },
      });
    }
    this.showSaveBanner();
  }

  async updateReminder(index: number, reminder: Reminder, source: MutationSource = 'manual'): Promise<void> {
    const existing = this.reminders[index];
    if (!existing?.id) return;

    const before = { name: existing.name, time: existing.time, days: existing.days, icon: existing.icon };

    const { data, error } = await supabase
      .from('reminders')
      .update({
        name: reminder.name,
        reminder_time: reminder.time,
        days: reminder.days,
        icon: reminder.icon,
      })
      .eq('id', existing.id)
      .select()
      .single();

    if (!error && data) {
      this.reminders[index] = reminderFromRow(data);
      const after = { name: reminder.name, time: reminder.time, days: reminder.days, icon: reminder.icon };
      const changes = diff(before as Record<string, unknown>, after as Record<string, unknown>);
      if (Object.keys(changes).length > 0) {
        emit({
          type: 'reminder.updated',
          entity_id: existing.id,
          entity_type: 'reminder',
          payload: { changes, source },
        });
      }
    }
    this.showSaveBanner();
  }

  async deleteReminder(index: number): Promise<void> {
    const existing = this.reminders[index];
    if (!existing?.id) return;

    await supabase.from('reminders').delete().eq('id', existing.id);
    emit({
      type: 'reminder.deleted',
      entity_id: existing.id,
      entity_type: 'reminder',
      payload: {},
    });
    this.reminders.splice(index, 1);
    this.showSaveBanner();
  }

  isReminderCompletedToday(reminder: Reminder): boolean {
    return reminder.id ? this.reminderCompletions.has(reminder.id) : false;
  }

  async toggleReminderCompletion(reminder: Reminder): Promise<void> {
    if (!reminder.id) return;
    const today = getTodayDate();

    if (this.reminderCompletions.has(reminder.id)) {
      // Uncomplete
      await supabase
        .from('reminder_completions')
        .delete()
        .eq('reminder_id', reminder.id)
        .eq('completion_date', today);
      this.reminderCompletions.delete(reminder.id);
      emit({
        type: 'reminder.uncompleted',
        entity_id: reminder.id,
        entity_type: 'reminder',
        payload: { date: today, reminder_name: reminder.name },
      });
    } else {
      // Complete
      await supabase
        .from('reminder_completions')
        .insert({ reminder_id: reminder.id, completion_date: today });
      this.reminderCompletions.add(reminder.id);
      emit({
        type: 'reminder.completed',
        entity_id: reminder.id,
        entity_type: 'reminder',
        payload: { date: today, reminder_name: reminder.name },
      });
    }
  }

  isReminderSkippedToday(reminder: Reminder): boolean {
    return reminder.id ? this.reminderSkips.has(reminder.id) : false;
  }

  async toggleReminderSkip(reminder: Reminder): Promise<void> {
    if (!reminder.id) return;
    const today = getTodayDate();

    if (this.reminderSkips.has(reminder.id)) {
      await supabase
        .from('reminder_skips')
        .delete()
        .eq('reminder_id', reminder.id)
        .eq('skip_date', today);
      this.reminderSkips.delete(reminder.id);
      emit({
        type: 'reminder.unskipped',
        entity_id: reminder.id,
        entity_type: 'reminder',
        payload: { date: today, reminder_name: reminder.name },
      });
    } else {
      await supabase
        .from('reminder_skips')
        .insert({ reminder_id: reminder.id, skip_date: today });
      this.reminderSkips.add(reminder.id);
      emit({
        type: 'reminder.skipped',
        entity_id: reminder.id,
        entity_type: 'reminder',
        payload: { date: today, reminder_name: reminder.name },
      });
    }
  }

  /** Load the last 7 days of reminder completion timestamps. */
  async loadReminderCompletionHistory(): Promise<void> {
    const since = new Date();
    since.setDate(since.getDate() - 7);
    const sinceDate = since.toISOString().slice(0, 10);

    const reminderIds = this.reminders.filter(r => r.id).map(r => r.id!);
    if (reminderIds.length === 0) {
      this.reminderCompletionHistory = [];
      return;
    }

    const { data } = await supabase
      .from('reminder_completions')
      .select('*')
      .in('reminder_id', reminderIds)
      .gte('completion_date', sinceDate)
      .order('completed_at');

    this.reminderCompletionHistory = (data || []) as ReminderCompletionRow[];
  }

  /** Compute optimal time suggestions based on 7-day completion history.
   *  Only suggests if there are 3+ data points and the average differs by 15+ minutes. */
  getReminderTimeSuggestions(): ReminderTimeSuggestion[] {
    const suggestions: ReminderTimeSuggestion[] = [];

    for (const reminder of this.reminders) {
      if (!reminder.id || this.dismissedSuggestions.has(reminder.id)) continue;

      // Get completions for this reminder
      const completions = this.reminderCompletionHistory.filter(
        c => c.reminder_id === reminder.id
      );

      if (completions.length < 3) continue;

      // Compute average completion time-of-day in minutes
      let totalMinutes = 0;
      for (const c of completions) {
        const dt = new Date(c.completed_at);
        totalMinutes += dt.getHours() * 60 + dt.getMinutes();
      }
      const avgMinutes = Math.round(totalMinutes / completions.length);

      // Parse scheduled time
      const [sh, sm] = reminder.time.split(':').map(Number);
      const scheduledMinutes = sh * 60 + sm;

      // Only suggest if the difference is 15+ minutes
      const diff = Math.abs(avgMinutes - scheduledMinutes);
      if (diff < 15) continue;

      // Round suggested time to nearest 5 minutes
      const rounded = Math.round(avgMinutes / 5) * 5;
      const sugH = Math.floor(rounded / 60) % 24;
      const sugM = rounded % 60;
      const suggestedTime = `${sugH.toString().padStart(2, '0')}:${sugM.toString().padStart(2, '0')}`;

      const avgH = Math.floor(avgMinutes / 60) % 24;
      const avgM = avgMinutes % 60;
      const avgTime = `${avgH.toString().padStart(2, '0')}:${avgM.toString().padStart(2, '0')}`;

      suggestions.push({
        reminderId: reminder.id,
        reminderName: reminder.name,
        reminderIcon: reminder.icon || '💊',
        scheduledTime: reminder.time,
        suggestedTime,
        avgCompletionTime: avgTime,
        dataPoints: completions.length,
      });
    }

    return suggestions;
  }

  // --- Streak ---

  private _streakCache: { value: number; computedAt: number } | null = null;

  async computeStreak(): Promise<number> {
    // Return cached value if computed in the last 5 minutes
    if (this._streakCache && Date.now() - this._streakCache.computedAt < 5 * 60 * 1000) {
      return this._streakCache.value;
    }
    if (!this.userId) return 0;

    const since = new Date();
    since.setDate(since.getDate() - 60);
    const sinceStr = since.toISOString().slice(0, 10);

    const blockIds = this.blocks.filter(b => b.id).map(b => b.id!);

    // Fetch dates with block completions
    const { data: completionRows } = blockIds.length > 0
      ? await supabase
          .from('block_completions')
          .select('completion_date')
          .in('block_id', blockIds)
          .gte('completion_date', sinceStr)
          .eq('status', 'done')
      : { data: [] };

    // Fetch dates with energy logs
    const { data: energyRows } = await supabase
      .from('energy_logs')
      .select('logged_at')
      .eq('user_id', this.userId)
      .gte('logged_at', since.toISOString());

    const activeDates = new Set<string>();
    for (const row of (completionRows || []) as { completion_date: string }[]) {
      activeDates.add(row.completion_date);
    }
    for (const row of (energyRows || []) as { logged_at: string }[]) {
      activeDates.add(row.logged_at.slice(0, 10));
    }
    // One-off blocks marked done
    for (const b of this.blocks) {
      if (b.date && b.status === 'done') activeDates.add(b.date);
    }

    // Count consecutive days backwards from today
    let streak = 0;
    const d = new Date();
    while (true) {
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (activeDates.has(dateStr)) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    }

    this._streakCache = { value: streak, computedAt: Date.now() };
    return streak;
  }

  invalidateStreakCache(): void {
    this._streakCache = null;
  }

  // --- UI ---

  showSaveBanner(): void {
    const banner = document.getElementById('saveBanner');
    if (!banner) return;
    banner.classList.add('show');
    setTimeout(() => banner.classList.remove('show'), 1500);
  }
}

export const state = new AppState();
