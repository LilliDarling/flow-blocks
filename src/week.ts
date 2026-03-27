import { state } from './state.js';
import { DAYS, TYPE_LABELS, getTodayIndex, getTodayDate, getDateForDayIndex, FlowBlock, $id } from './utils.js';
import { openModal, openModalForSlot } from './modal.js';
import type { CalendarEvent } from './calendar/types.js';

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

export function renderWeek(): void {
  const grid = $id('weekGrid');
  const hours: string[] = [];
  for (let h = 6; h <= 22; h++) {
    hours.push(`${h.toString().padStart(2, '0')}:00`);
  }

  const todayIdx = getTodayIndex();

  let html = '<div class="week-header"></div>';
  DAYS.forEach((d, i) => {
    html += `<div class="week-header ${i === todayIdx ? 'today' : ''}">${d}</div>`;
  });

  hours.forEach(hour => {
    const h = parseInt(hour);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    html += `<div class="week-time-label">${h12}${ampm}</div>`;

    DAYS.forEach((_, dayIdx) => {
      const date = getDateForDayIndex(dayIdx);

      // Find ALL flow blocks at this hour
      const matchedBlocks = state.blocks.filter(b => {
        if (!blockVisibleOnDay(b, dayIdx)) return false;
        const [bh] = b.start.split(':').map(Number);
        const endH = bh + b.duration / 60;
        return h >= bh && h < endH;
      });

      // Find ALL calendar events at this hour
      const dayEvents = state.weekCalendarEvents.get(date) || [];
      const calEvents = dayEvents.filter(e => {
        if (e.allDay) return false;
        const [eh] = e.start.split(':').map(Number);
        const endH = eh + e.duration / 60;
        return h >= eh && h < endH;
      });

      const totalItems = matchedBlocks.length + calEvents.length;

      if (totalItems === 0) {
        html += `<div class="week-cell" data-day="${dayIdx}" data-hour="${hour}"></div>`;
      } else if (totalItems === 1 && matchedBlocks.length === 1) {
        const block = matchedBlocks[0];
        const ridx = state.blocks.indexOf(block);
        html += `<div class="week-cell filled type-${block.type}" data-block-index="${ridx}">
          <div class="week-cell-label">${block.title || TYPE_LABELS[block.type]}</div>
        </div>`;
      } else if (totalItems === 1 && calEvents.length === 1) {
        const calEvent = calEvents[0];
        const colorIdx = dayEvents.indexOf(calEvent) % 8;
        html += `<div class="week-cell filled calendar-event cal-color-${colorIdx}">
          <div class="week-cell-label">${calEvent.title}</div>
        </div>`;
      } else {
        html += `<div class="week-cell filled multi">`;
        matchedBlocks.forEach(block => {
          const ridx = state.blocks.indexOf(block);
          html += `<div class="week-block type-${block.type}" data-block-index="${ridx}">
            <div class="week-cell-label">${block.title || TYPE_LABELS[block.type]}</div>
          </div>`;
        });
        calEvents.forEach(calEvent => {
          const colorIdx = dayEvents.indexOf(calEvent) % 8;
          html += `<div class="week-block calendar-event cal-color-${colorIdx}">
            <div class="week-cell-label">${calEvent.title}</div>
          </div>`;
        });
        html += `</div>`;
      }
    });
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
    const cell = (e.target as HTMLElement).closest('.week-cell:not(.filled)') as HTMLElement | null;
    if (cell && cell.dataset.day && cell.dataset.hour) {
      openModalForSlot(parseInt(cell.dataset.day), cell.dataset.hour);
    }
  });
}
