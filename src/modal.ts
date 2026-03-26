import { state } from './state.js';
import { DAYS, BlockType, FlowBlock, fmtTime, addMinutes, $id, getTodayIndex, getTodayDate, getDateForDayIndex, TYPE_LABELS, BLOCK_TYPE_KEYWORDS, BLOCK_MENU_SUGGESTIONS } from './utils.js';
import { renderTimeline } from './timeline.js';
import { renderWeek } from './week.js';
import { confirmDelete } from './confirm-delete.js';

let scheduleMode: 'today' | 'recurring' = 'today';
let suggestTimeout: ReturnType<typeof setTimeout> | null = null;

/** Suggest a block type based on title keywords and user history. */
function suggestBlockType(title: string): BlockType | null {
  const words = title.toLowerCase().split(/\s+/);

  // 1. Check user's own history first (exact title match)
  const existing = state.blocks.find(
    b => b.title.toLowerCase() === title.toLowerCase() && b.title.length > 0
  );
  if (existing) return existing.type;

  // 2. Keyword match
  for (const word of words) {
    if (BLOCK_TYPE_KEYWORDS[word]) return BLOCK_TYPE_KEYWORDS[word];
  }

  return null;
}

function populateTimeOptions(): void {
  const sel = $id('blockStart') as HTMLSelectElement;
  if (sel.options.length > 0) return;
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const val = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = fmtTime(val);
      sel.appendChild(opt);
    }
  }
}

function setScheduleMode(mode: 'today' | 'recurring'): void {
  scheduleMode = mode;
  $id('schedToday').classList.toggle('selected', mode === 'today');
  $id('schedRecurring').classList.toggle('selected', mode === 'recurring');
  $id('datePickerGroup').style.display = mode === 'today' ? 'block' : 'none';
  $id('dayPickersGroup').style.display = mode === 'recurring' ? 'block' : 'none';

  if (mode === 'today') {
    state.selectedDays = [getTodayIndex()];
  }
}

export function openModal(index = -1): void {
  state.editingIndex = index;
  state.selectedType = '';
  state.selectedDays = [];
  suggestedType = null;

  $id('deleteBtn').style.display = index >= 0 ? 'block' : 'none';
  $id('modalTitle').textContent = index >= 0 ? 'Edit Block' : 'Add Block';

  const titleInput = $id('blockTitle') as HTMLInputElement;
  const menuInput = $id('blockMenu') as HTMLTextAreaElement;
  const startSelect = $id('blockStart') as HTMLSelectElement;
  const durationSelect = $id('blockDuration') as HTMLSelectElement;

  populateTimeOptions();

  if (index >= 0) {
    const b = state.blocks[index];
    state.selectedType = b.type;
    state.selectedDays = [...b.days];
    titleInput.value = b.title;
    menuInput.value = b.menu.join('\n');
    startSelect.value = b.start;
    durationSelect.value = String(b.duration);

    // Determine mode from existing block
    if (b.date) {
      ($id('blockDate') as HTMLInputElement).value = b.date;
      setScheduleMode('today');
    } else {
      ($id('blockDate') as HTMLInputElement).value = getTodayDate();
      setScheduleMode('recurring');
    }
  } else {
    state.selectedDays = [getTodayIndex()];
    titleInput.value = '';
    menuInput.value = '';
    startSelect.value = '09:00';
    durationSelect.value = '60';
    ($id('blockDate') as HTMLInputElement).value = getTodayDate();
    setScheduleMode('today');
  }

  renderDayPickers();
  renderTypeSelection();
  // Show menu suggestions if editing a block with a known type
  if (state.selectedType) {
    renderMenuSuggestions(state.selectedType as BlockType);
  } else {
    $id('menuSuggestions').innerHTML = '';
  }
  $id('modal').classList.add('open');
}

export function openModalForSlot(dayIdx: number, hour: string): void {
  state.editingIndex = -1;
  state.selectedType = '';
  state.selectedDays = [dayIdx];

  $id('deleteBtn').style.display = 'none';
  $id('modalTitle').textContent = 'Add Block';
  ($id('blockTitle') as HTMLInputElement).value = '';
  ($id('blockMenu') as HTMLTextAreaElement).value = '';
  populateTimeOptions();
  ($id('blockStart') as HTMLSelectElement).value = hour;
  ($id('blockDuration') as HTMLSelectElement).value = '60';

  setScheduleMode('recurring');
  renderDayPickers();
  renderTypeSelection();
  $id('modal').classList.add('open');
}

export function closeModal(): void {
  $id('modal').classList.remove('open');
}

function selectType(type: string): void {
  state.selectedType = type;
  suggestedType = null;
  renderTypeSelection();
  renderMenuSuggestions(type as BlockType);
}

function renderMenuSuggestions(type: BlockType): void {
  const container = $id('menuSuggestions');
  if (!container) return;

  const menuInput = $id('blockMenu') as HTMLTextAreaElement;
  const currentItems = menuInput.value.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);

  // Get user's past menu items for this block type (deduplicated)
  const pastItems = new Set<string>();
  for (const block of state.blocks) {
    if (block.type === type && block.menu) {
      for (const item of block.menu) {
        if (!currentItems.includes(item.toLowerCase())) {
          pastItems.add(item);
        }
      }
    }
  }

  // Combine: user's past items first, then defaults (skip duplicates and already-added items)
  const suggestions: string[] = [];
  const seen = new Set<string>();

  for (const item of pastItems) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      suggestions.push(item);
    }
  }

  for (const item of (BLOCK_MENU_SUGGESTIONS[type] || [])) {
    const key = item.toLowerCase();
    if (!seen.has(key) && !currentItems.includes(key)) {
      seen.add(key);
      suggestions.push(item);
    }
  }

  if (suggestions.length === 0) {
    container.innerHTML = '';
    return;
  }

  const pastCount = pastItems.size;
  container.innerHTML =
    `<div class="menu-suggestions-label">Tap to add:</div>` +
    suggestions.map((s, i) =>
      `<button type="button" class="menu-chip${i < pastCount ? ' menu-chip-personal' : ''}" data-menu-item="${s.replace(/"/g, '&quot;')}">${s}</button>`
    ).join('');
}

function addMenuSuggestion(item: string): void {
  const menuInput = $id('blockMenu') as HTMLTextAreaElement;
  const current = menuInput.value.trim();
  menuInput.value = current ? current + '\n' + item : item;
  // Re-render to remove the added chip
  const type = (state.selectedType || suggestedType) as BlockType;
  if (type) renderMenuSuggestions(type);
}

let suggestedType: BlockType | null = null;

function renderTypeSelection(): void {
  document.querySelectorAll<HTMLElement>('.type-option[data-type]').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.type === state.selectedType);
    btn.classList.toggle('suggested', !state.selectedType && btn.dataset.type === suggestedType);
  });
}

function onTitleInput(): void {
  if (suggestTimeout) clearTimeout(suggestTimeout);
  suggestTimeout = setTimeout(() => {
    const title = ($id('blockTitle') as HTMLInputElement).value.trim();
    suggestedType = title.length >= 2 ? suggestBlockType(title) : null;
    // Only show suggestion highlight and menu suggestions if user hasn't manually picked a type yet
    if (!state.selectedType) {
      renderTypeSelection();
      if (suggestedType) {
        renderMenuSuggestions(suggestedType);
      } else {
        $id('menuSuggestions').innerHTML = '';
      }
    }
  }, 300);
}

function renderDayPickers(): void {
  const el = $id('dayPickers');
  el.innerHTML = DAYS.map((d, i) => {
    const sel = state.selectedDays.includes(i);
    return `<button class="type-option" data-day-pick="${i}" style="padding:6px 10px;font-size:0.75rem;${sel ? 'border-color:var(--accent);background:var(--accent-glow)' : ''}">${d}</button>`;
  }).join('');
}

function toggleDay(i: number): void {
  if (state.selectedDays.includes(i)) {
    state.selectedDays = state.selectedDays.filter(d => d !== i);
  } else {
    state.selectedDays.push(i);
  }
  renderDayPickers();
}

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function findOverlap(start: string, duration: number, days: number[], date: string | null): FlowBlock | null {
  const newStart = toMinutes(start);
  const newEnd = newStart + duration;

  for (let i = 0; i < state.blocks.length; i++) {
    if (i === state.editingIndex) continue;
    const b = state.blocks[i];
    const bStart = toMinutes(b.start);
    const bEnd = bStart + b.duration;

    if (newStart >= bEnd || newEnd <= bStart) continue;

    const today = getTodayDate();

    // Time ranges overlap — check if they share any day
    if (date && b.date) {
      if (date === b.date) return b;
    } else if (date) {
      // New one-off vs existing recurring: only conflict if the date is >= existing block's creation
      const d = new Date(date + 'T00:00:00');
      const dayIdx = d.getDay() === 0 ? 6 : d.getDay() - 1;
      if (b.days.includes(dayIdx)) {
        if (!b.created_at || date >= b.created_at.slice(0, 10)) return b;
      }
    } else if (b.date) {
      // New recurring vs existing one-off: ignore past one-off blocks
      if (b.date < today) continue;
      const d = new Date(b.date + 'T00:00:00');
      const dayIdx = d.getDay() === 0 ? 6 : d.getDay() - 1;
      if (days.includes(dayIdx)) return b;
    } else {
      // Both recurring: only conflict on days from today forward
      if (days.some(d => b.days.includes(d))) return b;
    }
  }
  return null;
}

async function saveBlock(): Promise<void> {
  // Use suggested type if user didn't explicitly pick one
  const effectiveType = state.selectedType || suggestedType;
  if (!effectiveType) {
    alert('Pick a block type!');
    return;
  }

  const isOneOff = scheduleMode === 'today';

  if (!isOneOff && state.selectedDays.length === 0) {
    alert('Select at least one day!');
    return;
  }

  const start = ($id('blockStart') as HTMLSelectElement).value;
  const duration = parseInt(($id('blockDuration') as HTMLSelectElement).value);
  const dateVal = ($id('blockDate') as HTMLInputElement).value;
  const pickedDate = isOneOff ? dateVal : null;
  const days = isOneOff ? [] : state.selectedDays;
  const date = pickedDate;

  const overlap = findOverlap(start, duration, days, date);
  if (overlap) {
    const label = overlap.title || overlap.type;
    const end = addMinutes(overlap.start, overlap.duration);
    alert(`Overlaps with "${label}" (${fmtTime(overlap.start)} – ${fmtTime(end)})`);
    return;
  }

  const block = {
    type: effectiveType as BlockType,
    title: ($id('blockTitle') as HTMLInputElement).value.trim(),
    menu: ($id('blockMenu') as HTMLTextAreaElement).value
      .split('\n').map(s => s.trim()).filter(Boolean),
    start,
    duration,
    days,
    date,
    status: state.editingIndex >= 0 ? state.blocks[state.editingIndex].status : 'pending' as const,
  };

  if (state.editingIndex >= 0) {
    await state.updateBlock(state.editingIndex, block);
  } else {
    await state.addBlock(block);
  }

  closeModal();
  renderTimeline();
  renderWeek();
}

async function deleteBlock(): Promise<void> {
  if (state.editingIndex < 0) return;

  const block = state.blocks[state.editingIndex];
  if (!block) return;

  const isRecurring = !block.date;
  const name = block.title || TYPE_LABELS[block.type] + ' block';
  const choice = await confirmDelete(name, isRecurring);

  if (!choice) return; // cancelled

  if (choice === 'this') {
    await state.updateBlockStatus(state.editingIndex, 'dismissed');
  } else {
    await state.deleteBlock(state.editingIndex);
  }

  closeModal();
  renderTimeline();
  renderWeek();
}

export function initModalEvents(): void {
  $id('modal').addEventListener('click', (e) => {
    if (e.target === $id('modal')) closeModal();
  });

  document.querySelectorAll<HTMLElement>('.type-option[data-type]').forEach(btn => {
    btn.addEventListener('click', () => selectType(btn.dataset.type!));
  });

  $id('schedToday').addEventListener('click', () => setScheduleMode('today'));
  $id('schedRecurring').addEventListener('click', () => setScheduleMode('recurring'));

  $id('dayPickers').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-day-pick]') as HTMLElement | null;
    if (btn) toggleDay(parseInt(btn.dataset.dayPick!));
  });

  // Title input for block type suggestion
  $id('blockTitle').addEventListener('input', onTitleInput);

  // Menu suggestion chips
  $id('menuSuggestions').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('[data-menu-item]') as HTMLElement | null;
    if (chip) addMenuSuggestion(chip.dataset.menuItem!);
  });

  $id('saveBtn').addEventListener('click', saveBlock);
  $id('deleteBtn').addEventListener('click', deleteBlock);
  $id('cancelBtn').addEventListener('click', closeModal);
}
