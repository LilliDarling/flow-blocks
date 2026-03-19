import { state } from './state.js';
import { fmtTime, addMinutes, getTodayIndex, getTodayDate, TYPE_LABELS, BlockStatus, ENERGY_FIT, FlowBlock, $id } from './utils.js';
import { openModal } from './modal.js';
import { confirmDelete } from './confirm-delete.js';
import type { CalendarEvent } from './calendar/types.js';

/** A unified item for timeline rendering — either a flow block or a calendar event. */
type TimelineItem =
  | { kind: 'block'; block: FlowBlock; index: number }
  | { kind: 'event'; event: CalendarEvent };

export function renderTimeline(): void {
  const tl = $id('timeline');
  const dayIndex = getTodayIndex();
  const today = getTodayDate();

  // Gather flow blocks for today, excluding dismissed ones
  const dayBlocks: TimelineItem[] = state.blocks
    .filter(b => {
      if (b.date) return b.date === today;
      if (!b.days.includes(dayIndex)) return false;
      if (b.created_at && today < b.created_at.slice(0, 10)) return false;
      // Hide blocks dismissed via "just this one" delete
      if (state.getEffectiveStatus(b, today) === 'dismissed') return false;
      return true;
    })
    .map(b => ({ kind: 'block' as const, block: b, index: state.blocks.indexOf(b) }));

  // Gather calendar events (skip all-day events from the main timeline)
  const calEvents: TimelineItem[] = state.calendarEvents
    .filter(e => !e.allDay)
    .map(e => ({ kind: 'event' as const, event: e }));

  // Merge and sort by start time; buffer blocks sort before other blocks at the same time
  const items: TimelineItem[] = [...dayBlocks, ...calEvents]
    .sort((a, b) => {
      const aStart = a.kind === 'block' ? a.block.start : a.event.start;
      const bStart = b.kind === 'block' ? b.block.start : b.event.start;
      const cmp = aStart.localeCompare(bStart);
      if (cmp !== 0) return cmp;
      // At same time: calendar events first, then buffers, then other blocks
      const aOrder = a.kind === 'event' ? 0 : a.block.type === 'buffer' ? 1 : 2;
      const bOrder = b.kind === 'event' ? 0 : b.block.type === 'buffer' ? 1 : 2;
      return aOrder - bOrder;
    });

  if (items.length === 0) {
    tl.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-dim)">
      <p style="font-size:1.4rem;margin-bottom:8px">No blocks yet</p>
      <p style="font-size:0.85rem">Hit "+ Add Block" to start building your day</p>
    </div>`;
    $id('doneSection').style.display = 'none';
    return;
  }

  tl.innerHTML = items.map(item => {
    if (item.kind === 'event') return renderCalendarEvent(item.event);
    return renderFlowBlock(item.block, item.index, today);
  }).join('');

  renderDoneList();
}

function renderFlowBlock(block: FlowBlock, realIndex: number, today: string): string {
  const endTime = addMinutes(block.start, block.duration);
  const menuHtml = block.menu.length
    ? block.menu.map(m => `<span>${m}</span>`).join('')
    : '';
  const effectiveStatus: BlockStatus = state.getEffectiveStatus(block, today);
  const statusClass =
    effectiveStatus === 'done' ? 'completed' :
    effectiveStatus === 'skipped' ? 'skipped' : '';
  const energy = state.energy;
  const [eMin, eMax] = ENERGY_FIT[block.type];
  const energyClass = effectiveStatus !== 'pending' ? '' :
    (energy >= eMin && energy <= eMax) ? 'energy-match' : 'energy-dim';

  return `<div class="time-block">
    <div class="time-label">${fmtTime(block.start)}</div>
    <div class="dot"></div>
    <div class="block-card type-${block.type} ${statusClass} ${energyClass}" data-index="${realIndex}">
      <div class="block-top">
        <span class="block-type-badge">${TYPE_LABELS[block.type]}</span>
        <span class="block-duration">${block.duration} min · until ${fmtTime(endTime)}</span>
      </div>
      <div class="block-title">${block.title || 'Untitled block'}</div>
      ${menuHtml ? `<div class="block-menu-items">${menuHtml}</div>` : ''}
      <div class="block-actions">
        <button class="block-action-btn done-btn" data-action="done" data-index="${realIndex}">Done</button>
        <button class="block-action-btn skip-btn" data-action="skip" data-index="${realIndex}">Skip</button>
        <button class="block-action-btn" data-action="edit" data-index="${realIndex}">Edit</button>
        <button class="block-action-btn delete-btn" data-action="delete" data-index="${realIndex}">Delete</button>
      </div>
    </div>
  </div>`;
}

function calColorClass(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0;
  }
  return `cal-color-${Math.abs(hash) % 8}`;
}

function renderCalendarEvent(event: CalendarEvent): string {
  const color = calColorClass(event.title);
  return `<div class="time-block">
    <div class="time-label">${fmtTime(event.start)}</div>
    <div class="dot"></div>
    <div class="block-card calendar-event ${color}">
      <div class="block-top">
        <span class="block-type-badge">${event.provider}</span>
        <span class="block-duration">${event.duration} min · until ${fmtTime(event.end)}</span>
      </div>
      <div class="block-title">${event.title}</div>
      <div class="cal-source-label">from ${event.provider} calendar</div>
    </div>
  </div>`;
}

function renderDoneList(): void {
  const section = $id('doneSection');
  if (state.doneItems.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  $id('doneList').innerHTML = state.doneItems.map(d =>
    `<div class="done-item">✓ ${d.text} <span style="float:right;opacity:0.5">${d.time}</span></div>`
  ).join('');
  $id('doneCount').textContent =
    `${state.doneItems.length} thing${state.doneItems.length !== 1 ? 's' : ''} accomplished`;
}

async function markDone(idx: number): Promise<void> {
  const block = state.blocks[idx];
  const title = block.title || TYPE_LABELS[block.type] + ' block';

  // Show a quick "when did you finish?" prompt
  const completedAt = await askCompletionTime();
  await state.updateBlockStatus(idx, 'done', completedAt ?? undefined);
  await state.addDoneItem(title);
  renderTimeline();
}

/** Quick inline prompt: "Just now" or pick an earlier time.
 *  Returns null for "just now" (lets DB default handle it),
 *  or a Date if the user picked an earlier time. */
function askCompletionTime(): Promise<Date | null> {
  return new Promise((resolve) => {
    const now = new Date();
    const container = document.createElement('div');
    container.className = 'completion-time-prompt';

    const nowH = now.getHours().toString().padStart(2, '0');
    const nowM = now.getMinutes().toString().padStart(2, '0');

    container.innerHTML = `
      <div class="completion-time-inner">
        <p>When did you finish this?</p>
        <div class="completion-time-options">
          <button class="btn btn-primary completion-now-btn">Just now</button>
          <div class="completion-earlier">
            <label>Earlier at:</label>
            <input type="time" class="completion-time-input" value="${nowH}:${nowM}">
            <button class="btn btn-ghost completion-earlier-btn">Set</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(container);

    const cleanup = () => container.remove();

    container.querySelector('.completion-now-btn')!.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });

    container.querySelector('.completion-earlier-btn')!.addEventListener('click', () => {
      const timeInput = container.querySelector('.completion-time-input') as HTMLInputElement;
      const [h, m] = timeInput.value.split(':').map(Number);
      const earlier = new Date();
      earlier.setHours(h, m, 0, 0);
      if (earlier > now) earlier.setTime(now.getTime());
      cleanup();
      resolve(earlier);
    });

    // Clicking outside dismisses and defaults to "just now"
    container.addEventListener('click', (e) => {
      if (e.target === container) {
        cleanup();
        resolve(null);
      }
    });
  });
}

async function markSkip(idx: number): Promise<void> {
  await state.updateBlockStatus(idx, 'skipped');
  renderTimeline();
}

async function deleteFromTimeline(idx: number): Promise<void> {
  const block = state.blocks[idx];
  if (!block) return;

  const isRecurring = !block.date;
  const name = block.title || TYPE_LABELS[block.type] + ' block';
  const choice = await confirmDelete(name, isRecurring);

  if (!choice) return; // cancelled

  if (choice === 'this') {
    // Dismiss just today's occurrence (hides from view)
    await state.updateBlockStatus(idx, 'dismissed');
  } else {
    // 'future' or 'all' — delete the block template
    await state.deleteBlock(idx);
  }
  renderTimeline();
}

export function initTimelineEvents(): void {
  $id('timeline').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const actionBtn = target.closest('[data-action]') as HTMLElement | null;
    if (actionBtn) {
      e.stopPropagation();
      const idx = parseInt(actionBtn.dataset.index!);
      const action = actionBtn.dataset.action;
      if (action === 'done') markDone(idx);
      else if (action === 'skip') markSkip(idx);
      else if (action === 'edit') openModal(idx);
      else if (action === 'delete') deleteFromTimeline(idx);
      return;
    }
  });

  $id('timeline').addEventListener('dblclick', (e) => {
    const card = (e.target as HTMLElement).closest('.block-card') as HTMLElement | null;
    if (card) {
      openModal(parseInt(card.dataset.index!));
    }
  });
}
