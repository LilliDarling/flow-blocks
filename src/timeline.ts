import { state } from './state.js';
import { fmtTime, addMinutes, getTodayIndex, getTodayDate, TYPE_LABELS, $id } from './utils.js';
import { openModal } from './modal.js';

export function renderTimeline(): void {
  const tl = $id('timeline');
  const dayIndex = getTodayIndex();
  const today = getTodayDate();
  const dayBlocks = state.blocks
    .filter(b => {
      if (b.date) return b.date === today;
      if (!b.days.includes(dayIndex)) return false;
      // Recurring blocks only show from their creation date forward
      if (b.created_at && today < b.created_at.slice(0, 10)) return false;
      return true;
    })
    .sort((a, b) => a.start.localeCompare(b.start));

  if (dayBlocks.length === 0) {
    tl.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-dim)">
      <p style="font-size:1.4rem;margin-bottom:8px">No blocks yet</p>
      <p style="font-size:0.85rem">Hit "+ Add Block" to start building your day</p>
    </div>`;
    $id('doneSection').style.display = 'none';
    return;
  }

  tl.innerHTML = dayBlocks.map(block => {
    const realIndex = state.blocks.indexOf(block);
    const endTime = addMinutes(block.start, block.duration);
    const menuHtml = block.menu.length
      ? block.menu.map(m => `<span>${m}</span>`).join('')
      : '';
    const statusClass =
      block.status === 'done' ? 'completed' :
      block.status === 'skipped' ? 'skipped' : '';

    return `<div class="time-block">
      <div class="time-label">${fmtTime(block.start)}</div>
      <div class="dot"></div>
      <div class="block-card type-${block.type} ${statusClass}" data-index="${realIndex}">
        <div class="block-top">
          <span class="block-type-badge">${TYPE_LABELS[block.type]}</span>
          <span class="block-duration">${block.duration} min · until ${fmtTime(endTime)}</span>
        </div>
        <div class="block-title">${block.title || 'Untitled block'}</div>
        ${menuHtml ? `<div class="block-menu-items">${menuHtml}</div>` : ''}
        <div class="block-actions">
          <button class="block-action-btn done-btn" data-action="done" data-index="${realIndex}">✓ Done</button>
          <button class="block-action-btn skip-btn" data-action="skip" data-index="${realIndex}">Skip</button>
          <button class="block-action-btn" data-action="edit" data-index="${realIndex}">Edit</button>
          <button class="block-action-btn delete-btn" data-action="delete" data-index="${realIndex}">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');

  renderDoneList();
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
  const title = state.blocks[idx].title || TYPE_LABELS[state.blocks[idx].type] + ' block';
  await state.updateBlockStatus(idx, 'done');
  await state.addDoneItem(title);
  renderTimeline();
}

async function markSkip(idx: number): Promise<void> {
  await state.updateBlockStatus(idx, 'skipped');
  renderTimeline();
}

async function deleteFromTimeline(idx: number): Promise<void> {
  await state.deleteBlock(idx);
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
