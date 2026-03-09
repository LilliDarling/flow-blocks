import { state } from './state.js';
import { DAYS, BlockType, FlowBlock, fmtTime, addMinutes, $id, getTodayIndex, getTodayDate, getDateForDayIndex } from './utils.js';
import { renderTimeline } from './timeline.js';
import { renderWeek } from './week.js';

let scheduleMode: 'today' | 'recurring' = 'today';

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

  $id('deleteBtn').style.display = index >= 0 ? 'block' : 'none';
  $id('modalTitle').textContent = index >= 0 ? 'Edit Block' : 'Add Flow Block';

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
  $id('modal').classList.add('open');
}

export function openModalForSlot(dayIdx: number, hour: string): void {
  state.editingIndex = -1;
  state.selectedType = '';
  state.selectedDays = [dayIdx];

  $id('deleteBtn').style.display = 'none';
  $id('modalTitle').textContent = 'Add Flow Block';
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
  renderTypeSelection();
}

function renderTypeSelection(): void {
  document.querySelectorAll<HTMLElement>('.type-option[data-type]').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.type === state.selectedType);
  });
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
  if (!state.selectedType) {
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
    type: state.selectedType as BlockType,
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
  if (state.editingIndex >= 0) {
    await state.deleteBlock(state.editingIndex);
    closeModal();
    renderTimeline();
    renderWeek();
  }
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

  $id('saveBtn').addEventListener('click', saveBlock);
  $id('deleteBtn').addEventListener('click', deleteBlock);
  $id('cancelBtn').addEventListener('click', closeModal);
}
