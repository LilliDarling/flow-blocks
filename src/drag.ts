import { state } from './state.js';
import { $id, fmtTime, getTodayDate, getTodayIndex } from './utils.js';
import { renderTimeline } from './timeline.js';

const LONG_PRESS_MS = 400;
const MOVE_THRESHOLD = 8; // px movement allowed before cancelling long-press
const SNAP_MINUTES = 15;

// Drag state
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let dragging = false;
let dragIndex = -1;
let ghostEl: HTMLElement | null = null;
let timeLabel: HTMLElement | null = null;
let startY = 0;
let lastY = 0;
let pressStartX = 0;
let pressStartY = 0;
let ghostInitialTop = 0;
let originalStartTime = '';
let pxPerMinute = 1.5;
let currentNewTime = '';

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(mins: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 45, mins));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function snap(mins: number): number {
  return Math.round(mins / SNAP_MINUTES) * SNAP_MINUTES;
}

/** Measure px-per-minute from actual rendered timeline blocks. */
function measurePxPerMinute(): void {
  const timeBlocks = Array.from($id('timeline').querySelectorAll('.time-block'));
  // Find two flow blocks with different start times
  for (let i = 0; i < timeBlocks.length - 1; i++) {
    const aCard = timeBlocks[i].querySelector('.block-card[data-index]') as HTMLElement | null;
    const bCard = timeBlocks[i + 1].querySelector('.block-card[data-index]') as HTMLElement | null;
    if (!aCard || !bCard) continue;

    const aIdx = parseInt(aCard.dataset.index!);
    const bIdx = parseInt(bCard.dataset.index!);
    const aBlock = state.blocks[aIdx];
    const bBlock = state.blocks[bIdx];
    if (!aBlock || !bBlock) continue;

    const timeDiff = toMinutes(bBlock.start) - toMinutes(aBlock.start);
    if (timeDiff <= 0) continue;

    const pxDiff = timeBlocks[i + 1].getBoundingClientRect().top - timeBlocks[i].getBoundingClientRect().top;
    if (pxDiff > 0) {
      pxPerMinute = pxDiff / timeDiff;
      pxPerMinute = Math.max(0.5, Math.min(4, pxPerMinute));
      return;
    }
  }
}

function beginDrag(card: HTMLElement, clientY: number): void {
  const idx = parseInt(card.dataset.index!);
  if (isNaN(idx) || !state.blocks[idx]) return;

  measurePxPerMinute();

  dragging = true;
  dragIndex = idx;
  startY = clientY;
  lastY = clientY;
  originalStartTime = state.blocks[idx].start;
  currentNewTime = originalStartTime;

  // Dim the original
  const timeBlock = card.closest('.time-block') as HTMLElement;
  timeBlock.classList.add('dragging');

  // Create ghost — fixed position copy of the card
  const rect = card.getBoundingClientRect();
  ghostEl = card.cloneNode(true) as HTMLElement;
  ghostEl.classList.add('drag-ghost');
  ghostEl.style.width = `${rect.width}px`;
  ghostEl.style.left = `${rect.left}px`;
  ghostEl.style.top = `${rect.top}px`;
  ghostInitialTop = rect.top;
  document.body.appendChild(ghostEl);

  // Floating time badge
  timeLabel = document.createElement('div');
  timeLabel.className = 'drag-time-indicator';
  timeLabel.textContent = fmtTime(originalStartTime);
  timeLabel.style.top = `${rect.top - 30}px`;
  timeLabel.style.left = `${rect.left}px`;
  document.body.appendChild(timeLabel);

  document.body.style.overflow = 'hidden';
  if (navigator.vibrate) navigator.vibrate(30);
}

function onMove(clientY: number): void {
  if (!dragging || !ghostEl || !timeLabel) return;

  lastY = clientY;
  const deltaY = clientY - startY;

  // Position ghost directly from initial position + delta
  ghostEl.style.top = `${ghostInitialTop + deltaY}px`;

  // Calculate new snapped time
  const deltaMin = deltaY / pxPerMinute;
  const newMin = snap(toMinutes(originalStartTime) + deltaMin);
  currentNewTime = fromMinutes(newMin);

  // Update badge
  timeLabel.textContent = fmtTime(currentNewTime);
  timeLabel.style.top = `${ghostInitialTop + deltaY - 30}px`;
}

/** Find the flow block whose time range the new time falls into. */
function findBlockAtTime(newTime: string, excludeIndex: number): number {
  const today = getTodayDate();
  const dayIndex = getTodayIndex();
  const newMin = toMinutes(newTime);

  for (let i = 0; i < state.blocks.length; i++) {
    if (i === excludeIndex) continue;
    const b = state.blocks[i];

    // Only consider blocks active today
    const isToday = b.date ? b.date === today : b.days.includes(dayIndex);
    if (!isToday) continue;

    const bStart = toMinutes(b.start);
    const bEnd = bStart + b.duration;

    if (newMin >= bStart && newMin < bEnd) {
      return i;
    }
  }
  return -1;
}

async function endDrag(): Promise<void> {
  if (!dragging) return;

  const newTime = currentNewTime;
  const savedDragIndex = dragIndex;
  cleanup();

  if (!newTime || newTime === originalStartTime) return;

  const draggedBlock = state.blocks[savedDragIndex];
  if (!draggedBlock) return;

  // Check if we're dropping onto another block — if so, swap times
  const targetIndex = findBlockAtTime(newTime, savedDragIndex);

  if (targetIndex >= 0) {
    const targetBlock = state.blocks[targetIndex];
    // Swap: target gets the dragged block's old time, dragged gets target's time
    await state.updateBlock(savedDragIndex, { ...draggedBlock, start: targetBlock.start }, 'drag');
    await state.updateBlock(targetIndex, { ...targetBlock, start: originalStartTime }, 'drag');
  } else {
    // No overlap — just move to the new time
    await state.updateBlock(savedDragIndex, { ...draggedBlock, start: newTime }, 'drag');
  }

  renderTimeline();
}

function cleanup(): void {
  dragging = false;
  if (ghostEl) { ghostEl.remove(); ghostEl = null; }
  if (timeLabel) { timeLabel.remove(); timeLabel = null; }
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  document.body.style.overflow = '';
  cancelPress();
}

function cancelPress(): void {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
}

export function initDragAndDrop(): void {
  const timeline = $id('timeline');

  // --- Pointer events (mouse + touch on most browsers) ---
  timeline.addEventListener('pointerdown', (e: PointerEvent) => {
    const card = (e.target as HTMLElement).closest('.block-card') as HTMLElement | null;
    if (!card || card.classList.contains('calendar-event')) return;
    if ((e.target as HTMLElement).closest('[data-action]')) return;

    pressStartX = e.clientX;
    pressStartY = e.clientY;

    pressTimer = setTimeout(() => {
      beginDrag(card, e.clientY);
    }, LONG_PRESS_MS);
  });

  document.addEventListener('pointermove', (e: PointerEvent) => {
    if (dragging) {
      e.preventDefault();
      onMove(e.clientY);
    } else if (pressTimer) {
      // Cancel long-press if finger/mouse moved too far
      const dx = e.clientX - pressStartX;
      const dy = e.clientY - pressStartY;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) {
        cancelPress();
      }
    }
  });

  document.addEventListener('pointerup', () => {
    if (dragging) endDrag();
    cancelPress();
  });

  document.addEventListener('pointercancel', () => {
    cleanup();
  });

  // --- Touch fallback for iOS ---
  timeline.addEventListener('touchmove', (e: TouchEvent) => {
    if (dragging) {
      e.preventDefault();
      onMove(e.touches[0].clientY);
    }
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (dragging) endDrag();
    cancelPress();
  });

  document.addEventListener('touchcancel', () => {
    cleanup();
  });

  // --- Right-click context prevention during drag ---
  timeline.addEventListener('contextmenu', (e) => {
    if (dragging) e.preventDefault();
  });
}
