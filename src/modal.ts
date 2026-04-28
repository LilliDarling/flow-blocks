import { state, POOL_MAX_ACTIVE } from './state.js';
import { DAYS, BlockType, FlowBlock, fmtTime, addMinutes, isScheduled, $id, getTodayIndex, getTodayDate, getDateForDayIndex, TYPE_LABELS, TYPE_DESCRIPTIONS, BLOCK_TYPE_KEYWORDS, BLOCK_MENU_SUGGESTIONS, esc } from './utils.js';
import { renderTimeline } from './timeline.js';
import { renderWeek } from './week.js';
import { confirmDelete } from './confirm-delete.js';

/** Show a transient error inside the add/edit modal. */
function showModalError(msg: string): void {
  const modal = document.querySelector('#modal .modal') as HTMLElement | null;
  if (!modal) return;
  let banner = modal.querySelector<HTMLElement>('.modal-error');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'modal-error';
    modal.insertBefore(banner, modal.firstChild);
  }
  banner.textContent = msg;
  banner.style.display = 'block';
}

function clearModalError(): void {
  const banner = document.querySelector<HTMLElement>('#modal .modal-error');
  if (banner) banner.style.display = 'none';
}

type PlacementMode = 'pool' | 'pinned';
type ScheduleMode = 'today' | 'recurring';
let placementMode: PlacementMode = 'pool';
let scheduleMode: ScheduleMode = 'today';
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

function setPlacementMode(mode: PlacementMode): void {
  placementMode = mode;
  $id('schedPool').classList.toggle('selected', mode === 'pool');
  $id('schedPinned').classList.toggle('selected', mode === 'pinned');
  $id('pinnedOptions').style.display = mode === 'pinned' ? 'block' : 'none';
}

function setScheduleMode(mode: ScheduleMode): void {
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
  clearModalError();
  $id('typeDescription').textContent = '';

  $id('deleteBtn').style.display = index >= 0 ? 'block' : 'none';
  $id('modalTitle').textContent = index >= 0 ? 'Edit' : 'Add something';

  const titleInput = $id('blockTitle') as HTMLInputElement;
  const menuInput = $id('blockMenu') as HTMLTextAreaElement;
  const startSelect = $id('blockStart') as HTMLSelectElement;
  const durationSelect = $id('blockDuration') as HTMLSelectElement;

  populateTimeOptions();

  if (index >= 0) {
    const b = state.blocks[index];
    state.selectedType = b.type;
    state.selectedDays = [...b.days];
    $id('typeDescription').textContent = TYPE_DESCRIPTIONS[b.type] || '';
    titleInput.value = b.title;
    menuInput.value = b.menu.join('\n');
    durationSelect.value = String(b.duration);

    // Determine placement mode from existing block
    if (isScheduled(b)) {
      startSelect.value = b.start;
      setPlacementMode('pinned');
      if (b.date) {
        ($id('blockDate') as HTMLInputElement).value = b.date;
        setScheduleMode('today');
      } else {
        ($id('blockDate') as HTMLInputElement).value = getTodayDate();
        setScheduleMode('recurring');
      }
    } else {
      setPlacementMode('pool');
      startSelect.value = '09:00';
      ($id('blockDate') as HTMLInputElement).value = getTodayDate();
      setScheduleMode('today');
    }
  } else {
    state.selectedDays = [getTodayIndex()];
    titleInput.value = '';
    menuInput.value = '';
    startSelect.value = '09:00';
    durationSelect.value = '60';
    ($id('blockDate') as HTMLInputElement).value = getTodayDate();
    setPlacementMode('pool');
    setScheduleMode('today');
  }

  renderDayPickers();
  renderTypeSelection();
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
  $id('typeDescription').textContent = '';

  $id('deleteBtn').style.display = 'none';
  $id('modalTitle').textContent = 'Add something';
  ($id('blockTitle') as HTMLInputElement).value = '';
  ($id('blockMenu') as HTMLTextAreaElement).value = '';
  populateTimeOptions();
  ($id('blockStart') as HTMLSelectElement).value = hour;
  ($id('blockDuration') as HTMLSelectElement).value = '60';

  setPlacementMode('pinned');
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
  $id('typeDescription').textContent = TYPE_DESCRIPTIONS[type as BlockType] || '';
}

const MAX_CHIPS = 8;
const MAX_PERSONAL_CHIPS = 5; // leave room for built-in variety

function renderMenuSuggestions(type: BlockType): void {
  const container = $id('menuSuggestions');
  if (!container) return;

  const menuInput = $id('blockMenu') as HTMLTextAreaElement;
  const currentItems = menuInput.value.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);

  // Count how often each menu item appears across the user's blocks of this
  // type — frequency = "what they commonly put in that category".
  const personalCounts = new Map<string, { display: string; count: number }>();
  for (const block of state.blocks) {
    if (block.type !== type || !block.menu) continue;
    for (const item of block.menu) {
      const key = item.toLowerCase();
      if (currentItems.includes(key)) continue;
      const existing = personalCounts.get(key);
      if (existing) existing.count++;
      else personalCounts.set(key, { display: item, count: 1 });
    }
  }

  const personalSorted = [...personalCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_PERSONAL_CHIPS)
    .map(p => p.display);

  const suggestions: string[] = [...personalSorted];
  const seen = new Set(personalSorted.map(s => s.toLowerCase()));

  for (const item of (BLOCK_MENU_SUGGESTIONS[type] || [])) {
    if (suggestions.length >= MAX_CHIPS) break;
    const key = item.toLowerCase();
    if (seen.has(key) || currentItems.includes(key)) continue;
    seen.add(key);
    suggestions.push(item);
  }

  if (suggestions.length === 0) {
    container.innerHTML = '';
    return;
  }

  const personalCount = personalSorted.length;
  container.innerHTML =
    `<div class="menu-suggestions-label">Tap to add:</div>` +
    suggestions.map((s, i) =>
      `<button type="button" class="menu-chip${i < personalCount ? ' menu-chip-personal' : ''}" data-menu-item="${esc(s)}">${esc(s)}</button>`
    ).join('');
}

function addMenuSuggestion(item: string): void {
  const menuInput = $id('blockMenu') as HTMLTextAreaElement;
  const current = menuInput.value.trim();
  menuInput.value = current ? current + '\n' + item : item;
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
  if (!start) return null; // pool blocks can't overlap

  const newStart = toMinutes(start);
  const newEnd = newStart + duration;
  const today = getTodayDate();

  for (let i = 0; i < state.blocks.length; i++) {
    if (i === state.editingIndex) continue;
    const b = state.blocks[i];
    if (!isScheduled(b)) continue; // skip pool blocks

    const checkDate = date || today;
    if (state.getEffectiveStatus(b, checkDate) === 'dismissed') continue;

    const bStart = toMinutes(b.start);
    const bEnd = bStart + b.duration;

    if (newStart >= bEnd || newEnd <= bStart) continue;

    if (date && b.date) {
      if (date === b.date) return b;
    } else if (date) {
      const d = new Date(date + 'T00:00:00');
      const dayIdx = d.getDay() === 0 ? 6 : d.getDay() - 1;
      if (b.days.includes(dayIdx)) {
        if (!b.created_at || date >= b.created_at.slice(0, 10)) return b;
      }
    } else if (b.date) {
      if (b.date < today) continue;
      const d = new Date(b.date + 'T00:00:00');
      const dayIdx = d.getDay() === 0 ? 6 : d.getDay() - 1;
      if (days.includes(dayIdx)) return b;
    } else {
      if (days.some(d => b.days.includes(d))) return b;
    }
  }
  return null;
}

async function saveBlock(): Promise<void> {
  const effectiveType = state.selectedType || suggestedType;
  if (!effectiveType) {
    alert('Pick an energy type!');
    return;
  }

  let start = '';
  let days: number[] = [];
  let date: string | null = null;

  if (placementMode === 'pinned') {
    start = ($id('blockStart') as HTMLSelectElement).value;
    const isOneOff = scheduleMode === 'today';

    if (!isOneOff && state.selectedDays.length === 0) {
      alert('Select at least one day!');
      return;
    }

    const dateVal = ($id('blockDate') as HTMLInputElement).value;
    date = isOneOff ? dateVal : null;
    days = isOneOff ? [] : state.selectedDays;

    const duration = parseInt(($id('blockDuration') as HTMLSelectElement).value);
    const overlap = findOverlap(start, duration, days, date);
    if (overlap) {
      const label = overlap.title || overlap.type;
      const end = addMinutes(overlap.start, overlap.duration);
      alert(`Overlaps with "${label}" (${fmtTime(overlap.start)} – ${fmtTime(end)})`);
      return;
    }
  } else {
    // Pool block: no start time, no date — persists until completed or removed
    start = '';
    date = null;
    days = [];
  }

  const duration = parseInt(($id('blockDuration') as HTMLSelectElement).value);

  // Mirror the server-side CHECK / trigger limits so the user sees the
  // truncation here, not a surprise rejection from the DB.
  const TITLE_MAX = 200;
  const MENU_ITEM_MAX = 100;
  const MENU_MAX_ITEMS = 20;

  const block: FlowBlock = {
    type: effectiveType as BlockType,
    title: ($id('blockTitle') as HTMLInputElement).value.trim().slice(0, TITLE_MAX),
    menu: ($id('blockMenu') as HTMLTextAreaElement).value
      .split('\n')
      .map(s => s.trim().slice(0, MENU_ITEM_MAX))
      .filter(Boolean)
      .slice(0, MENU_MAX_ITEMS),
    start,
    duration,
    days,
    date,
    status: state.editingIndex >= 0 ? state.blocks[state.editingIndex].status : 'pending' as const,
  };

  if (state.editingIndex >= 0) {
    await state.updateBlock(state.editingIndex, block, 'modal');
  } else {
    const added = await state.addBlock(block, 'modal');
    if (!added) {
      // Pool cap hit — surface inline and keep the modal open so the user
      // can adjust instead of losing what they typed.
      showModalError(`Your pool is full (${state.countActivePool()}/${POOL_MAX_ACTIVE}). Complete or remove something before adding more.`);
      return;
    }
  }

  closeModal();
  renderTimeline();
  renderWeek();
}

async function deleteBlock(): Promise<void> {
  if (state.editingIndex < 0) return;

  const block = state.blocks[state.editingIndex];
  if (!block) return;

  const isRecurring = !block.date && block.days.length > 0;
  const name = block.title || TYPE_LABELS[block.type] + ' block';
  const choice = await confirmDelete(name, isRecurring);

  if (!choice) return;

  if (choice === 'this') {
    await state.updateBlockStatus(state.editingIndex, 'dismissed');
  } else {
    await state.deleteBlock(state.editingIndex, 'modal');
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

  // Placement mode: pool vs pinned
  $id('schedPool').addEventListener('click', () => setPlacementMode('pool'));
  $id('schedPinned').addEventListener('click', () => setPlacementMode('pinned'));

  // Schedule sub-mode: one-off vs recurring (only visible when pinned)
  $id('schedToday').addEventListener('click', () => setScheduleMode('today'));
  $id('schedRecurring').addEventListener('click', () => setScheduleMode('recurring'));

  $id('dayPickers').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-day-pick]') as HTMLElement | null;
    if (btn) toggleDay(parseInt(btn.dataset.dayPick!));
  });

  $id('blockTitle').addEventListener('input', onTitleInput);

  $id('menuSuggestions').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('[data-menu-item]') as HTMLElement | null;
    if (chip) addMenuSuggestion(chip.dataset.menuItem!);
  });

  $id('saveBtn').addEventListener('click', saveBlock);
  $id('deleteBtn').addEventListener('click', deleteBlock);
  $id('cancelBtn').addEventListener('click', closeModal);
}
