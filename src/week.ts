import { state } from './state.js';
import { DAYS, TYPE_LABELS, BlockStatus, getTodayIndex, getDateForDayIndex, FlowBlock, isScheduled, fmtTime, fmtDuration, normalizeDoneTime, localDateFromIso, $id, esc } from './utils.js';
import type { DoneItem } from './utils.js';
import { openModal, openModalForSlot } from './modal.js';
import type { CalendarEvent } from './calendar/types.js';

const START_HOUR = 6;
const END_HOUR = 22;
const TOTAL_HOURS = END_HOUR - START_HOUR + 1;
const HOUR_H = 44;
const COL_HEIGHT = TOTAL_HOURS * HOUR_H;

function blockVisibleOnDay(b: FlowBlock, dayIdx: number): boolean {
  if (b.date) {
    return b.date === getDateForDayIndex(dayIdx);
  }
  if (!b.days.includes(dayIdx)) return false;
  // Recurring blocks only show from their creation date forward
  if (b.created_at) {
    const columnDate = getDateForDayIndex(dayIdx);
    const createdDate = b.created_at.slice(0, 10);
    if (columnDate < createdDate) return false;
  }
  return true;
}

interface DayItem {
  startMin: number;
  endMin: number;
  block?: FlowBlock;
  blockIdx?: number;
  status?: BlockStatus;
  calEvent?: CalendarEvent;
  calColorIdx?: number;
  doneItem?: DoneItem;
}

/** Fallback height for a done_item without a duration (pool completions / freeform). */
const DONE_FALLBACK_MIN = 20;

export function renderWeek(): void {
  const grid = $id('weekGrid');
  const todayIdx = getTodayIndex();

  // Headers
  let html = '<div class="week-header"></div>';
  DAYS.forEach((d, i) => {
    const shade = i % 2 === 1 ? 'day-shade' : '';
    html += `<div class="week-header ${shade} ${i === todayIdx ? 'today' : ''}">${d}</div>`;
  });

  // Time labels column
  html += `<div class="week-times" style="height:${COL_HEIGHT}px">`;
  for (let h = START_HOUR; h <= END_HOUR; h++) {
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    const top = (h - START_HOUR) * HOUR_H;
    html += `<div class="week-time-label" style="top:${top}px">${h12}${ampm}</div>`;
  }
  html += '</div>';

  // Day columns
  DAYS.forEach((_, dayIdx) => {
    const date = getDateForDayIndex(dayIdx);
    const shade = dayIdx % 2 === 1 ? 'day-shade' : '';
    html += `<div class="week-day-col ${shade}" style="height:${COL_HEIGHT}px">`;

    // Hour slot backgrounds (clickable to create new blocks)
    for (let h = START_HOUR; h <= END_HOUR; h++) {
      const top = (h - START_HOUR) * HOUR_H;
      const hour = `${h.toString().padStart(2, '0')}:00`;
      html += `<div class="week-hour-slot" style="top:${top}px;height:${HOUR_H}px" data-day="${dayIdx}" data-hour="${hour}"></div>`;
    }

    // Collect all items for this day
    const items: DayItem[] = [];

    state.blocks.forEach((b, idx) => {
      if (!blockVisibleOnDay(b, dayIdx)) return;
      if (!isScheduled(b)) return; // skip pool blocks — they have no time position
      const status = state.getEffectiveStatus(b, date);
      if (status === 'dismissed') return;
      // Completed blocks are rendered from done_items at their actual completion
      // time instead — avoids duplication and respects user's logged timestamp.
      if (status === 'done') return;
      const [bh, bm] = b.start.split(':').map(Number);
      const startMin = bh * 60 + (bm || 0);
      const endMin = startMin + b.duration;
      items.push({ startMin, endMin, block: b, blockIdx: idx, status });
    });

    const dayEvents = state.weekCalendarEvents.get(date) || [];
    dayEvents.forEach((e, eIdx) => {
      if (e.allDay) return;
      const [eh, em] = e.start.split(':').map(Number);
      const startMin = eh * 60 + (em || 0);
      const endMin = startMin + e.duration;
      items.push({ startMin, endMin, calEvent: e, calColorIdx: eIdx % 8 });
    });

    // Done items for this day — slot into the grid at their logged time,
    // regardless of whether they came from a pinned block, a pool completion,
    // or a freeform "did something else" log.
    state.doneItems.forEach(d => {
      if (localDateFromIso(d.created_at) !== date) return;
      const t = normalizeDoneTime(d.time);
      const [dh, dm] = t.split(':').map(Number);
      let startMin = dh * 60 + (dm || 0);
      // Clamp to visible window so nothing silently disappears
      const minStart = START_HOUR * 60;
      const maxStart = END_HOUR * 60 - 10;
      if (startMin < minStart) startMin = minStart;
      if (startMin > maxStart) startMin = maxStart;
      const durMin = d.duration_minutes && d.duration_minutes > 0 ? d.duration_minutes : DONE_FALLBACK_MIN;
      const endMin = startMin + durMin;
      items.push({ startMin, endMin, doneItem: d });
    });

    // Greedy column assignment for overlapping items
    const sorted = [...items].sort((a, b) => a.startMin - b.startMin || (b.endMin - b.startMin) - (a.endMin - a.startMin));
    const colMap = new Map<DayItem, number>();
    const colEnds: number[] = [];

    for (const item of sorted) {
      let col = colEnds.findIndex(end => end <= item.startMin);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(item.endMin);
      } else {
        colEnds[col] = item.endMin;
      }
      colMap.set(item, col);
    }

    // Render positioned items
    for (const item of items) {
      const col = colMap.get(item)!;

      // Find max column index among items overlapping with this one
      let maxCol = col;
      for (const other of items) {
        if (other === item) continue;
        if (other.startMin < item.endMin && other.endMin > item.startMin) {
          maxCol = Math.max(maxCol, colMap.get(other)!);
        }
      }
      const totalCols = maxCol + 1;

      const top = ((item.startMin / 60) - START_HOUR) * HOUR_H;
      const height = Math.max(((item.endMin - item.startMin) / 60) * HOUR_H, 18);
      const left = (col / totalCols) * 100;
      const width = (1 / totalCols) * 100;

      if (item.block) {
        const statusClass = item.status === 'skipped' ? 'skipped' : '';
        const statusIcon = item.status === 'skipped' ? '<span class="week-cell-status">–</span>' : '';
        html += `<div class="week-block type-${item.block.type} ${statusClass}" data-block-index="${item.blockIdx}" style="top:${top}px;height:${height}px;left:${left}%;width:${width}%">
          ${statusIcon}<div class="week-cell-label">${esc(item.block.title || TYPE_LABELS[item.block.type])}</div>
        </div>`;
      } else if (item.calEvent) {
        html += `<div class="week-block calendar-event cal-color-${item.calColorIdx}" data-cal-title="${esc(item.calEvent.title)}" data-cal-start="${item.calEvent.start}" data-cal-end="${item.calEvent.end}" data-cal-duration="${item.calEvent.duration}" data-cal-provider="${esc(item.calEvent.provider)}" style="top:${top}px;height:${height}px;left:${left}%;width:${width}%">
          <div class="week-cell-label">${esc(item.calEvent.title)}</div>
        </div>`;
      } else if (item.doneItem) {
        const d = item.doneItem;
        const durAttr = d.duration_minutes && d.duration_minutes > 0 ? String(d.duration_minutes) : '';
        const durationBadge = d.duration_minutes && d.duration_minutes > 0
          ? `<span class="week-done-dur">${fmtDuration(d.duration_minutes)}</span>`
          : '';
        const titleAttr = d.duration_minutes && d.duration_minutes > 0
          ? `${d.text} · ${fmtTime(normalizeDoneTime(d.time))} · ${fmtDuration(d.duration_minutes)}`
          : `${d.text} · ${fmtTime(normalizeDoneTime(d.time))}`;
        html += `<div class="week-block week-done" title="${esc(titleAttr)}" data-done-text="${esc(d.text)}" data-done-time="${esc(normalizeDoneTime(d.time))}" data-done-duration="${esc(durAttr)}" style="top:${top}px;height:${height}px;left:${left}%;width:${width}%">
          <span class="week-done-check">✓</span>
          <div class="week-cell-label">${esc(d.text)}</div>
          ${durationBadge}
        </div>`;
      }
    }

    html += '</div>';
  });

  grid.innerHTML = html;
}

function closeCalPopover(): void {
  const existing = document.querySelector('.week-cal-popover');
  if (existing) existing.remove();
}

function showDonePopover(el: HTMLElement): void {
  closeCalPopover();
  const text = el.dataset.doneText || '';
  const time = el.dataset.doneTime || '';
  const durStr = el.dataset.doneDuration || '';
  const durMin = durStr ? parseInt(durStr) : 0;
  const durLine = durMin > 0 ? ` · ${fmtDuration(durMin)}` : '';

  const pop = document.createElement('div');
  pop.className = 'week-cal-popover';
  pop.innerHTML = `
    <div class="week-cal-popover-title">✓ ${esc(text)}</div>
    <div class="week-cal-popover-time">${fmtTime(time)}${durLine}</div>
    <div class="week-cal-popover-source">completed</div>`;

  const rect = el.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = `${rect.top}px`;
  pop.style.left = `${rect.right + 8}px`;

  document.body.appendChild(pop);

  const popRect = pop.getBoundingClientRect();
  if (popRect.right > window.innerWidth - 8) {
    pop.style.left = `${rect.left - popRect.width - 8}px`;
  }
  if (popRect.bottom > window.innerHeight - 8) {
    pop.style.top = `${window.innerHeight - popRect.height - 8}px`;
  }
}

function showCalPopover(el: HTMLElement): void {
  closeCalPopover();
  const title = el.dataset.calTitle || '';
  const start = el.dataset.calStart || '';
  const end = el.dataset.calEnd || '';
  const duration = el.dataset.calDuration || '';
  const provider = el.dataset.calProvider || '';

  const pop = document.createElement('div');
  pop.className = 'week-cal-popover';
  pop.innerHTML = `
    <div class="week-cal-popover-title">${esc(title)}</div>
    <div class="week-cal-popover-time">${fmtTime(start)} – ${fmtTime(end)} · ${duration} min</div>
    <div class="week-cal-popover-source">from ${esc(provider)} calendar</div>`;

  // Position near the clicked element
  const rect = el.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = `${rect.top}px`;
  pop.style.left = `${rect.right + 8}px`;

  document.body.appendChild(pop);

  // If it overflows right, flip to left side
  const popRect = pop.getBoundingClientRect();
  if (popRect.right > window.innerWidth - 8) {
    pop.style.left = `${rect.left - popRect.width - 8}px`;
  }
  // If it overflows bottom, shift up
  if (popRect.bottom > window.innerHeight - 8) {
    pop.style.top = `${window.innerHeight - popRect.height - 8}px`;
  }
}

export function initWeekEvents(): void {
  $id('weekGrid').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Block click → open edit modal
    const blockEl = target.closest('[data-block-index]') as HTMLElement | null;
    if (blockEl && blockEl.dataset.blockIndex) {
      closeCalPopover();
      openModal(parseInt(blockEl.dataset.blockIndex));
      return;
    }

    // Calendar event click → show detail popover
    const calEl = target.closest('.calendar-event[data-cal-title]') as HTMLElement | null;
    if (calEl) {
      showCalPopover(calEl);
      return;
    }

    // Done item click → show detail popover (so short cells can still be read)
    const doneEl = target.closest('.week-done[data-done-text]') as HTMLElement | null;
    if (doneEl) {
      showDonePopover(doneEl);
      return;
    }

    // If a popover was open, this click just dismisses it — don't also
    // create a new event.
    const hadPopover = !!document.querySelector('.week-cal-popover');
    closeCalPopover();
    if (hadPopover) return;

    // Hour slot click → create new block
    const slot = target.closest('.week-hour-slot') as HTMLElement | null;
    if (slot && slot.dataset.day && slot.dataset.hour) {
      openModalForSlot(parseInt(slot.dataset.day), slot.dataset.hour);
    }
  });

  // Close popover when clicking outside the grid
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.week-cal-popover') &&
        !target.closest('.calendar-event[data-cal-title]') &&
        !target.closest('.week-done[data-done-text]')) {
      closeCalPopover();
    }
  });
}
