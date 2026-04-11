import { state } from './state.js';
import { DAYS, TYPE_LABELS, getTodayIndex, getTodayDate, getDateForDayIndex, FlowBlock, isScheduled, $id, esc } from './utils.js';
import { openModal, openModalForSlot } from './modal.js';
import type { CalendarEvent } from './calendar/types.js';

const START_HOUR = 6;
const END_HOUR = 22;
const TOTAL_HOURS = END_HOUR - START_HOUR + 1;
const HOUR_H = 44;
const COL_HEIGHT = TOTAL_HOURS * HOUR_H;

function blockVisibleOnDay(b: FlowBlock, dayIdx: number): boolean {
  if (b.date) {
    const d = new Date(b.date + 'T00:00:00');
    const idx = d.getDay() === 0 ? 6 : d.getDay() - 1;
    return idx === dayIdx;
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
  calEvent?: CalendarEvent;
  calColorIdx?: number;
}

export function renderWeek(): void {
  const grid = $id('weekGrid');
  const todayIdx = getTodayIndex();

  // Headers
  let html = '<div class="week-header"></div>';
  DAYS.forEach((d, i) => {
    html += `<div class="week-header ${i === todayIdx ? 'today' : ''}">${d}</div>`;
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
    html += `<div class="week-day-col" style="height:${COL_HEIGHT}px">`;

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
      const [bh, bm] = b.start.split(':').map(Number);
      const startMin = bh * 60 + (bm || 0);
      const endMin = startMin + b.duration;
      items.push({ startMin, endMin, block: b, blockIdx: idx });
    });

    const dayEvents = state.weekCalendarEvents.get(date) || [];
    dayEvents.forEach((e, eIdx) => {
      if (e.allDay) return;
      const [eh, em] = e.start.split(':').map(Number);
      const startMin = eh * 60 + (em || 0);
      const endMin = startMin + e.duration;
      items.push({ startMin, endMin, calEvent: e, calColorIdx: eIdx % 8 });
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
        html += `<div class="week-block type-${item.block.type}" data-block-index="${item.blockIdx}" style="top:${top}px;height:${height}px;left:${left}%;width:${width}%">
          <div class="week-cell-label">${esc(item.block.title || TYPE_LABELS[item.block.type])}</div>
        </div>`;
      } else if (item.calEvent) {
        html += `<div class="week-block calendar-event cal-color-${item.calColorIdx}" style="top:${top}px;height:${height}px;left:${left}%;width:${width}%">
          <div class="week-cell-label">${esc(item.calEvent.title)}</div>
        </div>`;
      }
    }

    html += '</div>';
  });

  grid.innerHTML = html;
}

export function initWeekEvents(): void {
  $id('weekGrid').addEventListener('dblclick', (e) => {
    const el = (e.target as HTMLElement).closest('[data-block-index]') as HTMLElement | null;
    if (el && el.dataset.blockIndex) {
      openModal(parseInt(el.dataset.blockIndex));
    }
  });

  $id('weekGrid').addEventListener('click', (e) => {
    const slot = (e.target as HTMLElement).closest('.week-hour-slot') as HTMLElement | null;
    if (slot && slot.dataset.day && slot.dataset.hour) {
      openModalForSlot(parseInt(slot.dataset.day), slot.dataset.hour);
    }
  });
}
