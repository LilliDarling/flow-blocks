import { supabase } from './supabase.js';
import {
  FlowBlock, DoneItem, PomoMode, PomoSettings,
  BlockStatus, CompletionRow, EnergyLogRow,
  blockFromRow, doneItemFromRow, getTodayDate,
} from './utils.js';
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

    // Fetch blocks
    const { data: blockRows } = await supabase
      .from('blocks')
      .select('*')
      .eq('user_id', userId)
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
  }

  // --- Block CRUD ---

  async addBlock(block: FlowBlock): Promise<void> {
    const row: Record<string, unknown> = {
      user_id: this.userId,
      type: block.type,
      title: block.title,
      menu: block.menu,
      start_time: block.start,
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
    }
    this.showSaveBanner();
  }

  async updateBlock(index: number, block: FlowBlock): Promise<void> {
    const existing = this.blocks[index];
    if (!existing?.id) return;

    const { data, error } = await supabase
      .from('blocks')
      .update({
        type: block.type,
        title: block.title,
        menu: block.menu,
        start_time: block.start,
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
    }
    this.showSaveBanner();
  }

  async deleteBlock(index: number): Promise<void> {
    const existing = this.blocks[index];
    if (!existing?.id) return;

    await supabase.from('blocks').delete().eq('id', existing.id);
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

  async updateBlockStatus(index: number, status: BlockStatus): Promise<void> {
    const existing = this.blocks[index];
    if (!existing?.id) return;

    if (existing.date) {
      // One-off block: update the block row directly (original behavior)
      await supabase.from('blocks').update({ status }).eq('id', existing.id);
      this.blocks[index].status = status;
    } else {
      // Recurring block: upsert into block_completions for today
      const today = getTodayDate();
      await supabase
        .from('block_completions')
        .upsert(
          { block_id: existing.id, completion_date: today, status },
          { onConflict: 'block_id,completion_date' }
        );
      this.completions.set(`${existing.id}_${today}`, status);
    }
  }

  // --- Calendar ---

  async loadCalendar(): Promise<void> {
    if (!this.userId) return;
    this.calendarConnections = await loadConnections(this.userId);
    if (this.calendarConnections.length > 0) {
      const today = getTodayDate();
      this.calendarEvents = await fetchAllEvents(this.calendarConnections, today);
      await this.reconcileBuffers();
    }
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
        await this.deleteBlock(i);
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
        await this.updateBlock(i, { ...block, start: expectedStart });
      }
    }
  }

  async checkCalendarRedirect(): Promise<boolean> {
    if (!this.userId) return false;
    const conn = await checkOAuthRedirect(this.userId);
    if (conn) {
      this.calendarConnections.push(conn);
      await this.loadCalendar();
      return true;
    }
    return false;
  }

  async removeCalendarConnection(connectionId: string): Promise<void> {
    await disconnectCalendar(connectionId);
    this.calendarConnections = this.calendarConnections.filter(c => c.id !== connectionId);
    // Re-fetch events without that connection
    const today = getTodayDate();
    this.calendarEvents = this.calendarConnections.length > 0
      ? await fetchAllEvents(this.calendarConnections, today)
      : [];
  }

  // --- Energy logging ---

  async logEnergy(value: number): Promise<void> {
    const { data } = await supabase
      .from('energy_logs')
      .insert({ user_id: this.userId, value })
      .select()
      .single();
    if (data) this.energyLogs.push(data as EnergyLogRow);
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

  async addDoneItem(text: string): Promise<void> {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const { data } = await supabase
      .from('done_items')
      .insert({ user_id: this.userId, text, time })
      .select()
      .single();

    if (data) {
      this.doneItems.push(doneItemFromRow(data));
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

  // --- UI ---

  showSaveBanner(): void {
    const banner = document.getElementById('saveBanner');
    if (!banner) return;
    banner.classList.add('show');
    setTimeout(() => banner.classList.remove('show'), 1500);
  }
}

export const state = new AppState();
