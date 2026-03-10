import { supabase } from './supabase.js';
import {
  FlowBlock, DoneItem, PomoMode, PomoSettings,
  BlockStatus, CompletionRow,
  blockFromRow, doneItemFromRow, getTodayDate,
} from './utils.js';

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

class AppState {
  blocks: FlowBlock[] = [];
  doneItems: DoneItem[] = [];
  completions: Map<string, BlockStatus> = new Map(); // "blockId_YYYY-MM-DD" -> status
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
    const { data, error } = await supabase
      .from('blocks')
      .insert({
        user_id: this.userId,
        type: block.type,
        title: block.title,
        menu: block.menu,
        start_time: block.start,
        duration: block.duration,
        days: block.days,
        block_date: block.date,
        status: block.status,
      })
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
