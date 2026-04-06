import { state } from '../state.js';
import { $id, fmtTime, addMinutes, getTodayDate, getTodayIndex, FlowBlock } from '../utils.js';
import { renderTimeline } from '../timeline.js';
import type { CalendarEvent } from './types.js';

interface BufferChoice {
  event: CalendarEvent;
  before: number; // 0 = no buffer, otherwise minutes
  after: number;
}

interface Conflict {
  event: CalendarEvent;
  block: FlowBlock;
  blockIndex: number;
  newStart: string;
}

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/** Find flow blocks that overlap with a calendar event (+ buffer zone) on today. */
function findConflicts(events: CalendarEvent[], bufferAfter: number = 10): Conflict[] {
  const today = getTodayDate();
  const dayIndex = getTodayIndex();
  const conflicts: Conflict[] = [];

  for (const event of events) {
    if (event.allDay) continue;
    const evStart = toMinutes(event.start);
    const evEnd = toMinutes(event.end);
    // Reserve event time + a default buffer zone for the preview
    // (actual buffer is applied later based on user choice)
    const reservedEnd = evEnd;

    for (let i = 0; i < state.blocks.length; i++) {
      const block = state.blocks[i];

      const isToday = block.date
        ? block.date === today
        : block.days.includes(dayIndex);
      if (!isToday) continue;

      const bStart = toMinutes(block.start);
      const bEnd = bStart + block.duration;

      if (bStart < reservedEnd && bEnd > evStart) {
        const newStart = fromMinutes(reservedEnd);

        if (!conflicts.some(c => c.blockIndex === i)) {
          conflicts.push({ event, block, blockIndex: i, newStart });
        }
      }
    }
  }

  return conflicts;
}

/** Show the calendar sync dialog. Only shows for non-all-day events. */
export function showCalendarSyncDialog(): void {
  const events = state.calendarEvents.filter(e => !e.allDay);
  if (events.length === 0) return;

  // Check sessionStorage to avoid showing repeatedly
  const syncKey = `cal_sync_${getTodayDate()}`;
  const seenIds = JSON.parse(sessionStorage.getItem(syncKey) || '[]') as string[];
  const newEvents = events.filter(e => !seenIds.includes(e.id));
  if (newEvents.length === 0) return;

  const conflicts = findConflicts(newEvents);
  const conflictBlockIds = new Set(conflicts.map(c => c.blockIndex));

  const container = $id('calSyncItems');
  container.innerHTML = newEvents.map((event, idx) => {
    const eventConflicts = conflicts.filter(c => c.event.id === event.id);
    const conflictHtml = eventConflicts.map(c =>
      `<div class="cal-sync-conflict">
        <strong>"${c.block.title || c.block.type}"</strong> (${fmtTime(c.block.start)} – ${fmtTime(addMinutes(c.block.start, c.block.duration))})
        overlaps — will move to <strong>${fmtTime(c.newStart)}</strong>
      </div>`
    ).join('');

    return `<div class="cal-sync-item" data-event-idx="${idx}">
      <div class="cal-sync-event-header">
        <span class="cal-sync-event-title">${event.title}</span>
        <span class="cal-sync-event-time">${fmtTime(event.start)} – ${fmtTime(event.end)}</span>
      </div>
      <div class="cal-sync-buffers">
        <div class="cal-sync-buffer-option" data-buf="before" data-idx="${idx}">
          <input type="checkbox" id="bufBefore${idx}">
          <label for="bufBefore${idx}">Buffer before</label>
          <select data-buf-dur="before" data-idx="${idx}">
            <option value="5">5m</option>
            <option value="10" selected>10m</option>
            <option value="15">15m</option>
          </select>
        </div>
        <div class="cal-sync-buffer-option" data-buf="after" data-idx="${idx}">
          <input type="checkbox" id="bufAfter${idx}">
          <label for="bufAfter${idx}">Buffer after</label>
          <select data-buf-dur="after" data-idx="${idx}">
            <option value="5">5m</option>
            <option value="10" selected>10m</option>
            <option value="15">15m</option>
          </select>
        </div>
      </div>
      ${conflictHtml}
    </div>`;
  }).join('');

  // Toggle active state on buffer options
  container.querySelectorAll('.cal-sync-buffer-option').forEach(el => {
    const checkbox = el.querySelector('input[type="checkbox"]') as HTMLInputElement;

    // Let the checkbox handle its own state; sync the visual class after
    checkbox.addEventListener('change', () => {
      el.classList.toggle('active', checkbox.checked);
    });

    // Clicking anywhere else in the row (not checkbox, label, or select) toggles it
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'SELECT' || target.tagName === 'INPUT' || target.tagName === 'LABEL') return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });
  });

  // Wire up buttons
  $id('calSyncSkip').onclick = () => {
    // Mark events as seen so dialog doesn't reappear
    const allIds = [...seenIds, ...newEvents.map(e => e.id)];
    sessionStorage.setItem(syncKey, JSON.stringify(allIds));
    $id('calSyncModal').classList.remove('open');
  };

  $id('calSyncApply').onclick = async () => {
    const bufferChoices: BufferChoice[] = newEvents.map((event, idx) => {
      const beforeCb = container.querySelector(`#bufBefore${idx}`) as HTMLInputElement;
      const afterCb = container.querySelector(`#bufAfter${idx}`) as HTMLInputElement;
      const beforeDur = container.querySelector(`[data-buf-dur="before"][data-idx="${idx}"]`) as HTMLSelectElement;
      const afterDur = container.querySelector(`[data-buf-dur="after"][data-idx="${idx}"]`) as HTMLSelectElement;
      return {
        event,
        before: beforeCb.checked ? parseInt(beforeDur.value) : 0,
        after: afterCb.checked ? parseInt(afterDur.value) : 0,
      };
    });

    await applySync(bufferChoices, conflicts);

    // Mark events as seen
    const allIds = [...seenIds, ...newEvents.map(e => e.id)];
    sessionStorage.setItem(syncKey, JSON.stringify(allIds));
    $id('calSyncModal').classList.remove('open');
    renderTimeline();
  };

  // Close on backdrop click
  $id('calSyncModal').onclick = (e) => {
    if (e.target === $id('calSyncModal')) {
      $id('calSyncSkip').click();
    }
  };

  $id('calSyncModal').classList.add('open');
}

async function applySync(choices: BufferChoice[], _conflicts: Conflict[]): Promise<void> {
  const today = getTodayDate();
  const dayIndex = getTodayIndex();

  // 1. Build reserved time ranges: each calendar event + chosen buffers
  const reserved: { start: number; end: number }[] = [];
  for (const choice of choices) {
    const evStart = toMinutes(choice.event.start);
    const evEnd = toMinutes(choice.event.end);
    reserved.push({
      start: evStart - choice.before,
      end: evEnd + choice.after,
    });
  }

  // Include bare calendar event ranges (for events where no buffer was chosen)
  for (const ev of state.calendarEvents) {
    if (ev.allDay) continue;
    const evStart = toMinutes(ev.start);
    const evEnd = toMinutes(ev.end);
    if (!reserved.some(r => r.start <= evStart && r.end >= evEnd)) {
      reserved.push({ start: evStart, end: evEnd });
    }
  }

  reserved.sort((a, b) => a.start - b.start);

  // 2. Push overlapping flow blocks FIRST (indices are stable before we add buffers)
  for (let i = 0; i < state.blocks.length; i++) {
    const block = state.blocks[i];

    const isToday = block.date ? block.date === today : block.days.includes(dayIndex);
    if (!isToday) continue;

    const bStart = toMinutes(block.start);
    const bEnd = bStart + block.duration;

    for (const r of reserved) {
      if (bStart < r.end && bEnd > r.start) {
        const newStart = fromMinutes(r.end);
        await state.updateBlock(i, { ...block, start: newStart }, 'calendar_sync');
        break;
      }
    }
  }

  // 3. Now create buffer blocks (won't affect indices of existing blocks)
  for (const choice of choices) {
    const evStart = toMinutes(choice.event.start);
    const evEnd = toMinutes(choice.event.end);

    if (choice.before > 0) {
      await state.addBlock({
        type: 'buffer',
        title: `Buffer before ${choice.event.title}`,
        menu: [],
        start: fromMinutes(evStart - choice.before),
        duration: choice.before,
        days: [],
        date: today,
        status: 'pending',
        linked_event_id: choice.event.id,
      }, 'calendar_sync');
    }
    if (choice.after > 0) {
      await state.addBlock({
        type: 'buffer',
        title: `Buffer after ${choice.event.title}`,
        menu: [],
        start: fromMinutes(evEnd),
        duration: choice.after,
        days: [],
        date: today,
        status: 'pending',
        linked_event_id: choice.event.id,
      }, 'calendar_sync');
    }
  }
}
