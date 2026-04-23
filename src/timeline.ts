import { state } from './state.js';
import { fmtTime, normalizeDoneTime, localDateFromIso, addMinutes, getTodayIndex, getTodayDate, TYPE_LABELS, BlockStatus, ENERGY_FIT, FlowBlock, isScheduled, $id, esc } from './utils.js';
import { openModal } from './modal.js';
import { confirmDelete } from './confirm-delete.js';
import type { CalendarEvent } from './calendar/types.js';

/** A unified item for the commitments section — pinned block or calendar event. */
type CommitmentItem =
  | { kind: 'block'; block: FlowBlock; index: number }
  | { kind: 'event'; event: CalendarEvent };

export function renderTimeline(): void {
  const dayIndex = getTodayIndex();
  const today = getTodayDate();
  const energy = state.energy;

  // ── Separate blocks into commitments (has start time) and pool (no start time) ──
  const commitmentBlocks: CommitmentItem[] = [];
  const poolBlocks: { block: FlowBlock; index: number }[] = [];

  state.blocks.forEach((b, idx) => {
    // Pool blocks (unscheduled): always show regardless of date/days — they persist
    if (!isScheduled(b)) {
      // Skip if completed/skipped today or dismissed
      if (b.status === 'done' || b.status === 'skipped') return;
      if (state.getEffectiveStatus(b, today) === 'dismissed') return;
      poolBlocks.push({ block: b, index: idx });
      return;
    }

    // Scheduled blocks: check if relevant today
    if (b.date) {
      if (b.date !== today) return;
    } else {
      if (!b.days.includes(dayIndex)) return;
      if (b.created_at && today < b.created_at.slice(0, 10)) return;
    }
    if (state.getEffectiveStatus(b, today) === 'dismissed') return;

    commitmentBlocks.push({ kind: 'block', block: b, index: idx });
  });

  // ── Render commitments section ──
  renderCommitments(commitmentBlocks, today);

  // ── Render pool section ──
  renderPool(poolBlocks, today, energy);

  // ── Done list ──
  renderDoneList();
}

function renderCommitments(blocks: CommitmentItem[], today: string): void {
  const section = $id('commitmentsSection');
  const list = $id('commitmentsList');

  // Add calendar events (skip all-day and hidden)
  const calEvents: CommitmentItem[] = state.calendarEvents
    .filter(e => !e.allDay && !state.hiddenCalendarEventIds.has(e.id))
    .map(e => ({ kind: 'event' as const, event: e }));

  const items: CommitmentItem[] = [...blocks, ...calEvents]
    .sort((a, b) => {
      const aStart = a.kind === 'block' ? a.block.start : a.event.start;
      const bStart = b.kind === 'block' ? b.block.start : b.event.start;
      const cmp = aStart.localeCompare(bStart);
      if (cmp !== 0) return cmp;
      const aOrder = a.kind === 'event' ? 0 : a.block.type === 'buffer' ? 1 : 2;
      const bOrder = b.kind === 'event' ? 0 : b.block.type === 'buffer' ? 1 : 2;
      return aOrder - bOrder;
    });

  if (items.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  const energy = state.energy;

  // Update count badge
  const countEl = $id('commitmentsCount');
  if (countEl) countEl.textContent = `(${items.length})`;

  list.innerHTML = items.map(item => {
    if (item.kind === 'event') return renderCalendarEvent(item.event);
    return renderCommitmentBlock(item.block, item.index, today, energy);
  }).join('');
}

function renderCommitmentBlock(block: FlowBlock, realIndex: number, today: string, energy: number): string {
  const endTime = addMinutes(block.start, block.duration);
  const menuHtml = block.menu.length > 1
    ? block.menu.map(m => `<span>${esc(m)}</span>`).join('')
    : '';
  const effectiveStatus: BlockStatus = state.getEffectiveStatus(block, today);
  const statusClass =
    effectiveStatus === 'done' ? 'completed' :
    effectiveStatus === 'skipped' ? 'skipped' : '';
  const [eMin, eMax] = ENERGY_FIT[block.type];
  const energyClass = effectiveStatus !== 'pending' ? '' :
    (energy >= eMin && energy <= eMax) ? 'energy-match' : 'energy-dim';

  return `<div class="commitment-item">
    <div class="commitment-time">${fmtTime(block.start)}</div>
    <div class="block-card type-${block.type} ${statusClass} ${energyClass}" data-index="${realIndex}">
      <div class="block-top">
        <span class="block-type-badge">${TYPE_LABELS[block.type]}</span>
        <span class="block-duration">${block.duration} min · until ${fmtTime(endTime)}</span>
      </div>
      <div class="block-title">${esc(block.title || 'Untitled block')}</div>
      ${menuHtml ? `<div class="block-menu-items">${menuHtml}</div>` : ''}
      <div class="block-actions">
        <button class="block-action-btn done-btn" data-action="done" data-index="${realIndex}">Did it</button>
        <button class="block-action-btn skip-btn" data-action="skip" data-index="${realIndex}">Not today</button>
        <button class="block-action-btn" data-action="unpin" data-index="${realIndex}">Unpin</button>
        <button class="block-action-btn" data-action="edit" data-index="${realIndex}">Edit</button>
        <button class="block-action-btn delete-btn" data-action="delete" data-index="${realIndex}">Remove</button>
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
  return `<div class="commitment-item">
    <div class="commitment-time">${fmtTime(event.start)}</div>
    <div class="block-card calendar-event ${color}" data-cal-id="${esc(event.id)}">
      <div class="block-top">
        <span class="block-type-badge">${event.provider}</span>
        <span class="block-duration">${event.duration} min · until ${fmtTime(event.end)}</span>
      </div>
      <div class="block-title">${esc(event.title)}</div>
      <div class="cal-source-label">from ${event.provider} calendar</div>
      <div class="cal-event-actions">
        <button class="block-action-btn cal-hide-btn" data-action="hide-event" data-cal-id="${esc(event.id)}">Hide from today</button>
      </div>
    </div>
  </div>`;
}

function renderPool(blocks: { block: FlowBlock; index: number }[], today: string, energy: number): void {
  const section = $id('poolSection');
  const grid = $id('poolGrid');
  const empty = $id('poolEmpty');
  const hint = $id('poolHint');

  // Sort: energy-matched items first, then by type
  const sorted = [...blocks].sort((a, b) => {
    const [aMin, aMax] = ENERGY_FIT[a.block.type];
    const [bMin, bMax] = ENERGY_FIT[b.block.type];
    const aMatch = energy >= aMin && energy <= aMax ? 0 : 1;
    const bMatch = energy >= bMin && energy <= bMax ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    return a.block.type.localeCompare(b.block.type);
  });

  const all = sorted;

  if (all.length === 0) {
    grid.style.display = 'none';
    empty.style.display = 'block';
    hint.style.display = 'none';
    return;
  }

  grid.style.display = '';
  empty.style.display = 'none';
  hint.style.display = '';

  grid.innerHTML = all.map(({ block, index }) => {
    const effectiveStatus = state.getEffectiveStatus(block, today);
    const statusClass =
      effectiveStatus === 'done' ? 'completed' :
      effectiveStatus === 'skipped' ? 'skipped' : '';

    const [eMin, eMax] = ENERGY_FIT[block.type];
    const energyClass = effectiveStatus !== 'pending' ? '' :
      (energy >= eMin && energy <= eMax) ? 'energy-match' : 'energy-dim';

    const menuHtml = block.menu.length > 1
      ? `<div class="pool-card-menu">${block.menu.map(m => `<span>${esc(m)}</span>`).join('')}</div>`
      : '';

    const durationLabel = block.duration ? `~${block.duration} min` : '';

    return `<div class="pool-card type-${block.type} ${statusClass} ${energyClass}" data-index="${index}">
      <div class="pool-card-top">
        <span class="block-type-badge">${TYPE_LABELS[block.type]}</span>
        ${durationLabel ? `<span class="pool-card-duration">${durationLabel}</span>` : ''}
      </div>
      <div class="pool-card-title">${esc(block.title || 'Untitled')}</div>
      ${menuHtml}
      <div class="pool-card-actions">
        <button class="block-action-btn done-btn" data-action="done" data-index="${index}">Did it</button>
        <button class="block-action-btn skip-btn" data-action="skip" data-index="${index}">Not today</button>
        <button class="block-action-btn" data-action="pin" data-index="${index}">Pin to time</button>
        <button class="block-action-btn" data-action="edit" data-index="${index}">Edit</button>
        <button class="block-action-btn delete-btn" data-action="delete" data-index="${index}">Remove</button>
      </div>
    </div>`;
  }).join('');
}

function renderDoneList(): void {
  const list = $id('doneList');
  const count = $id('doneCount');

  // state.doneItems now spans the last 7 days (for the week view) — filter
  // the daily list to just today (by local date, not UTC), sorted by
  // time-of-day.
  const today = getTodayDate();
  const todayItems = state.doneItems
    .filter(d => localDateFromIso(d.created_at) === today)
    .sort((a, b) => normalizeDoneTime(a.time).localeCompare(normalizeDoneTime(b.time)));

  if (todayItems.length === 0) {
    list.innerHTML = '';
    count.textContent = '';
    return;
  }

  list.innerHTML = todayItems.map(d =>
    `<div class="done-item">✓ ${esc(d.text)} <span style="float:right;opacity:0.5">${fmtTime(normalizeDoneTime(d.time))}</span></div>`
  ).join('');
  count.textContent =
    `${todayItems.length} thing${todayItems.length !== 1 ? 's' : ''} done`;
}

/** Prompt to log something that wasn't in the app — freeform text + time. */
function logSomethingElse(): void {
  const now = new Date();
  const nowH = now.getHours().toString().padStart(2, '0');
  const nowM = now.getMinutes().toString().padStart(2, '0');

  const container = document.createElement('div');
  container.className = 'completion-time-prompt';
  container.innerHTML = `
    <div class="completion-time-inner">
      <p>What did you do?</p>
      <input type="text" class="log-other-input" placeholder="e.g. Went out to eat, took a nap, ran errands..." autofocus maxlength="120">
      <p style="margin-top:16px">When?</p>
      <div class="completion-time-options">
        <button class="btn btn-primary completion-now-btn">Just now</button>
        <div class="completion-earlier">
          <label>At:</label>
          <input type="time" class="completion-time-input" value="${nowH}:${nowM}">
          <button class="btn btn-ghost completion-earlier-btn">Set</button>
        </div>
      </div>
      <button class="btn btn-ghost completion-cancel-btn" style="margin-top:12px">Cancel</button>
    </div>`;

  document.body.appendChild(container);

  const textInput = container.querySelector('.log-other-input') as HTMLInputElement;
  const cleanup = () => container.remove();

  const save = async (at: Date | null) => {
    const text = textInput.value.trim();
    if (!text) { textInput.focus(); return; }
    cleanup();
    await state.addDoneItem(text, at ?? undefined);
    renderTimeline();
  };

  container.querySelector('.completion-now-btn')!.addEventListener('click', () => save(null));

  container.querySelector('.completion-earlier-btn')!.addEventListener('click', () => {
    const timeInput = container.querySelector('.completion-time-input') as HTMLInputElement;
    const [h, m] = timeInput.value.split(':').map(Number);
    const earlier = new Date();
    earlier.setHours(h, m, 0, 0);
    if (earlier > now) earlier.setTime(now.getTime());
    save(earlier);
  });

  container.querySelector('.completion-cancel-btn')!.addEventListener('click', cleanup);
  container.addEventListener('click', (e) => {
    if (e.target === container) cleanup();
  });

  setTimeout(() => textInput.focus(), 100);
}

async function markDone(idx: number): Promise<void> {
  const block = state.blocks[idx];
  const title = block.title || TYPE_LABELS[block.type] + ' block';

  const result = await askCompletionDetails(block);
  if (!result) return;

  await state.updateBlockStatus(idx, 'done', result.completedAt ?? undefined, result.menuItemsDone);

  const doneText = result.menuItemsDone.length > 0
    ? result.menuItemsDone.join(', ')
    : title;
  await state.addDoneItem(doneText, result.completedAt ?? undefined, block.id);
  renderTimeline();
}

interface CompletionResult {
  completedAt: Date | null;
  menuItemsDone: string[];
}

function askCompletionDetails(block: FlowBlock): Promise<CompletionResult | null> {
  return new Promise((resolve) => {
    const now = new Date();
    const container = document.createElement('div');
    container.className = 'completion-time-prompt';

    const nowH = now.getHours().toString().padStart(2, '0');
    const nowM = now.getMinutes().toString().padStart(2, '0');

    const menuHtml = block.menu.length > 0
      ? `<div class="completion-menu-items">
          <p>What did you do?</p>
          ${block.menu.map((item, i) =>
            `<label class="completion-menu-option">
              <input type="checkbox" value="${i}"> ${esc(item)}
            </label>`
          ).join('')}
        </div>`
      : '';

    container.innerHTML = `
      <div class="completion-time-inner">
        ${menuHtml}
        <p>When did you finish?</p>
        <div class="completion-time-options">
          <button class="btn btn-primary completion-now-btn">Just now</button>
          <div class="completion-earlier">
            <label>Earlier at:</label>
            <input type="time" class="completion-time-input" value="${nowH}:${nowM}">
            <button class="btn btn-ghost completion-earlier-btn">Set</button>
          </div>
        </div>
        <button class="btn btn-ghost completion-cancel-btn">Cancel</button>
      </div>`;

    document.body.appendChild(container);

    const cleanup = () => container.remove();

    const getSelectedItems = (): string[] => {
      const checked = container.querySelectorAll<HTMLInputElement>('.completion-menu-option input:checked');
      return Array.from(checked).map(cb => block.menu[parseInt(cb.value)]);
    };

    container.querySelector('.completion-now-btn')!.addEventListener('click', () => {
      const items = getSelectedItems();
      cleanup();
      resolve({ completedAt: null, menuItemsDone: items });
    });

    container.querySelector('.completion-earlier-btn')!.addEventListener('click', () => {
      const timeInput = container.querySelector('.completion-time-input') as HTMLInputElement;
      const [h, m] = timeInput.value.split(':').map(Number);
      const earlier = new Date();
      earlier.setHours(h, m, 0, 0);
      if (earlier > now) earlier.setTime(now.getTime());
      const items = getSelectedItems();
      cleanup();
      resolve({ completedAt: earlier, menuItemsDone: items });
    });

    container.querySelector('.completion-cancel-btn')!.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });

    container.addEventListener('click', (e) => {
      if (e.target === container) {
        cleanup();
        resolve(null);
      }
    });
  });
}

/** Unpin a block — remove its start time and date so it becomes a persistent pool item. */
async function unpinBlock(idx: number): Promise<void> {
  const block = state.blocks[idx];
  if (!block) return;
  await state.updateBlock(idx, { ...block, start: '', date: null, days: [] }, 'manual');
  renderTimeline();
}

/** Pin a pool block to a specific time via a quick prompt. */
async function pinBlock(idx: number): Promise<void> {
  const block = state.blocks[idx];
  if (!block) return;

  const now = new Date();
  const h = now.getHours().toString().padStart(2, '0');
  const m = (Math.ceil(now.getMinutes() / 15) * 15 % 60).toString().padStart(2, '0');
  const defaultTime = `${h}:${m}`;

  const container = document.createElement('div');
  container.className = 'completion-time-prompt';
  container.innerHTML = `
    <div class="completion-time-inner">
      <p>Pin to what time?</p>
      <input type="time" class="completion-time-input" value="${defaultTime}" style="margin-bottom:16px;text-align:center;font-size:1.1rem">
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="btn btn-primary pin-confirm-btn">Pin it</button>
        <button class="btn btn-ghost pin-cancel-btn">Cancel</button>
      </div>
    </div>`;

  document.body.appendChild(container);

  container.querySelector('.pin-confirm-btn')!.addEventListener('click', async () => {
    const timeInput = container.querySelector('.completion-time-input') as HTMLInputElement;
    const today = getTodayDate();
    await state.updateBlock(idx, {
      ...block,
      start: timeInput.value,
      date: block.date || today,
      days: block.date ? block.days : [],
    }, 'manual');
    container.remove();
    renderTimeline();
  });

  container.querySelector('.pin-cancel-btn')!.addEventListener('click', () => {
    container.remove();
  });

  container.addEventListener('click', (e) => {
    if (e.target === container) container.remove();
  });
}

async function markSkip(idx: number): Promise<void> {
  await state.updateBlockStatus(idx, 'skipped');
  renderTimeline();
}

async function deleteFromTimeline(idx: number): Promise<void> {
  const block = state.blocks[idx];
  if (!block) return;

  const isRecurring = !block.date && block.days.length > 0;
  const name = block.title || TYPE_LABELS[block.type] + ' block';
  const choice = await confirmDelete(name, isRecurring);

  if (!choice) return;

  if (choice === 'this') {
    await state.updateBlockStatus(idx, 'dismissed');
  } else {
    await state.deleteBlock(idx, 'timeline');
  }
  renderTimeline();
}

/** "Day went sideways" — unpin all remaining scheduled blocks back to pool. */
async function dayWentSideways(): Promise<void> {
  const today = getTodayDate();
  const dayIndex = getTodayIndex();

  const toUnpin: number[] = [];
  state.blocks.forEach((b, idx) => {
    if (!isScheduled(b)) return;
    if (b.date) {
      if (b.date !== today) return;
    } else {
      if (!b.days.includes(dayIndex)) return;
    }
    const status = state.getEffectiveStatus(b, today);
    if (status !== 'pending') return;
    if (b.linked_event_id) return;
    toUnpin.push(idx);
  });

  if (toUnpin.length === 0) return;

  for (const idx of toUnpin) {
    const block = state.blocks[idx];
    await state.updateBlock(idx, { ...block, start: '', date: null, days: [] }, 'manual');
  }

  // Show a brief confirmation so it doesn't feel like nothing happened
  const banner = document.createElement('div');
  banner.className = 'sideways-confirmation';
  banner.textContent = `${toUnpin.length} thing${toUnpin.length !== 1 ? 's' : ''} moved back to your pool`;
  $id('day-view').insertBefore(banner, $id('poolSection'));
  setTimeout(() => banner.remove(), 3000);

  renderTimeline();
}

export function initTimelineEvents(): void {
  // Handle clicks on both commitments and pool sections
  const dayView = $id('day-view');

  dayView.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const actionBtn = target.closest('[data-action]') as HTMLElement | null;
    if (actionBtn) {
      e.stopPropagation();
      const idx = parseInt(actionBtn.dataset.index!);
      const action = actionBtn.dataset.action;
      if (action === 'hide-event') {
        const calId = actionBtn.dataset.calId;
        if (calId) { state.hideCalendarEvent(calId); renderTimeline(); }
      } else if (action === 'done') markDone(idx);
      else if (action === 'skip') markSkip(idx);
      else if (action === 'edit') openModal(idx);
      else if (action === 'delete') deleteFromTimeline(idx);
      else if (action === 'unpin') unpinBlock(idx);
      else if (action === 'pin') pinBlock(idx);
      return;
    }
  });

  // Double-click to edit
  dayView.addEventListener('dblclick', (e) => {
    const card = (e.target as HTMLElement).closest('.block-card, .pool-card') as HTMLElement | null;
    if (card && card.dataset.index) {
      openModal(parseInt(card.dataset.index));
    }
  });

  // "Day went sideways" button
  const sidewaysBtn = $id('sidewaysBtn');
  if (sidewaysBtn) {
    sidewaysBtn.addEventListener('click', dayWentSideways);
  }

  // Commitments collapse/expand toggle
  const toggle = $id('commitmentsToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      $id('commitmentsSection').classList.toggle('collapsed');
    });
  }

  // "Did something else?" button
  const logOtherBtn = $id('logOtherBtn');
  if (logOtherBtn) {
    logOtherBtn.addEventListener('click', logSomethingElse);
  }
}
