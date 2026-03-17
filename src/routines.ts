import { state } from './state.js';
import { DAYS, Reminder, fmtTime, getTodayIndex, getTodayDate, $id } from './utils.js';
import { confirmDelete } from './confirm-delete.js';

const DEFAULT_ICON = '💊';

let editingReminderIndex = -1;
let selectedDays: number[] = [];
let reminderTimers: ReturnType<typeof setTimeout>[] = [];
let lastScheduledDate: string = '';

export function renderReminders(): void {
  const dayIndex = getTodayIndex();

  // --- Today's reminders (excluding dismissed) ---
  const todayReminders = state.reminders.filter(r =>
    r.days.includes(dayIndex) && !(r.id && state.reminderDismissals.has(r.id))
  );
  const completedCount = todayReminders.filter(r => state.isReminderCompletedToday(r)).length;
  const totalCount = todayReminders.length;

  let progressHtml = '';
  if (totalCount > 0) {
    const pct = Math.round((completedCount / totalCount) * 100);
    progressHtml = `
      <div class="reminder-progress">
        <div class="reminder-progress-bar">
          <div class="reminder-progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="reminder-progress-text">${completedCount}/${totalCount}</span>
      </div>`;
  }

  const listHtml = todayReminders.length > 0
    ? todayReminders.map(r => {
        const realIndex = state.reminders.indexOf(r);
        const done = state.isReminderCompletedToday(r);
        return `<div class="reminder-item ${done ? 'reminder-done' : ''}" data-reminder-idx="${realIndex}">
          <button class="reminder-check" data-reminder-toggle="${realIndex}">${done ? '✓' : ''}</button>
          <span class="reminder-icon">${r.icon || '💊'}</span>
          <div class="reminder-info">
            <span class="reminder-name">${r.name}</span>
            <span class="reminder-time">${fmtTime(r.time)}</span>
          </div>
          <button class="reminder-edit-btn" data-reminder-edit="${realIndex}">Edit</button>
        </div>`;
      }).join('')
    : `<p class="reminder-empty">No reminders scheduled for today — tap "+ Add Reminder" to create one</p>`;

  $id('remindersList').innerHTML = progressHtml + listHtml;

  // --- All reminders list ---
  renderManageList();
}

export function scheduleReminders(fireMissed = false): void {
  // Clear existing timers
  reminderTimers.forEach(t => clearTimeout(t));
  reminderTimers = [];

  const dayIndex = getTodayIndex();
  const now = new Date();
  lastScheduledDate = getTodayDate();

  for (const reminder of state.reminders) {
    if (!reminder.days.includes(dayIndex)) continue;
    if (state.isReminderCompletedToday(reminder)) continue;

    const [h, m] = reminder.time.split(':').map(Number);
    const reminderDate = new Date();
    reminderDate.setHours(h, m, 0, 0);

    const diff = reminderDate.getTime() - now.getTime();

    if (diff <= 0) {
      // Already past — fire now if returning from background
      if (fireMissed) {
        showReminderNotification(reminder);
      }
      continue;
    }

    const timer = setTimeout(() => {
      // Only notify if still not completed
      if (!state.isReminderCompletedToday(reminder)) {
        showReminderNotification(reminder);
      }
    }, diff);

    reminderTimers.push(timer);
  }
}

function showReminderNotification(reminder: Reminder): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const n = new Notification(`${reminder.icon || '💊'} ${reminder.name}`, {
    body: `Gentle reminder — it's ${fmtTime(reminder.time)}`,
    icon: '/icons/icon.svg',
    tag: `reminder-${reminder.id}`,
  });
  setTimeout(() => n.close(), 15000);
}

function openReminderModal(index = -1): void {
  editingReminderIndex = index;

  const modal = $id('reminderModal');
  const nameInput = $id('reminderName') as HTMLInputElement;
  const timeInput = $id('reminderTime') as HTMLInputElement;

  $id('reminderModalTitle').textContent = index >= 0 ? 'Edit Reminder' : 'Add Reminder';
  $id('reminderDeleteBtn').style.display = index >= 0 ? 'block' : 'none';

  if (index >= 0) {
    const r = state.reminders[index];
    nameInput.value = r.name;
    timeInput.value = r.time;
    selectedDays = [...r.days];
    ($id('reminderIconInput') as HTMLInputElement).value = r.icon || DEFAULT_ICON;
  } else {
    nameInput.value = '';
    timeInput.value = '08:00';
    selectedDays = [0, 1, 2, 3, 4, 5, 6]; // Default: every day
    ($id('reminderIconInput') as HTMLInputElement).value = DEFAULT_ICON;
  }

  renderReminderDayPickers();
  modal.classList.add('open');
}

function closeReminderModal(): void {
  $id('reminderModal').classList.remove('open');
}


function renderReminderDayPickers(): void {
  $id('reminderDayPickers').innerHTML = DAYS.map((d, i) => {
    const sel = selectedDays.includes(i);
    return `<button class="type-option" data-reminder-day="${i}" style="padding:6px 10px;font-size:0.75rem;${sel ? 'border-color:var(--accent);background:var(--accent-glow)' : ''}">${d}</button>`;
  }).join('');
}

async function saveReminder(): Promise<void> {
  const name = ($id('reminderName') as HTMLInputElement).value.trim();
  if (!name) { alert('Give your reminder a name!'); return; }
  if (selectedDays.length === 0) { alert('Select at least one day!'); return; }

  const time = ($id('reminderTime') as HTMLInputElement).value;
  const icon = ($id('reminderIconInput') as HTMLInputElement).value.trim() || DEFAULT_ICON;

  const reminder: Reminder = { name, time, days: selectedDays, icon };

  if (editingReminderIndex >= 0) {
    await state.updateReminder(editingReminderIndex, reminder);
  } else {
    await state.addReminder(reminder);
  }

  closeReminderModal();
  renderReminders();
  scheduleReminders();
}

async function deleteReminder(): Promise<void> {
  if (editingReminderIndex < 0) return;

  const reminder = state.reminders[editingReminderIndex];
  if (!reminder) return;

  // Reminders are always recurring
  const choice = await confirmDelete(reminder.name, true);
  if (!choice) return;

  if (choice === 'this') {
    // Dismiss this occurrence — hide from today's view
    if (reminder.id) state.reminderDismissals.add(reminder.id);
  } else {
    // 'future' or 'all' — delete the reminder
    await state.deleteReminder(editingReminderIndex);
  }

  closeReminderModal();
  renderReminders();
  scheduleReminders();
}

async function toggleCompletion(index: number): Promise<void> {
  const reminder = state.reminders[index];
  if (!reminder) return;
  await state.toggleReminderCompletion(reminder);
  renderReminders();
  scheduleReminders();
}

export function initReminderEvents(): void {
  // Add reminder button
  $id('addReminderBtn').addEventListener('click', () => openReminderModal());

  // Reminder list interactions (toggle + edit)
  $id('remindersList').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const toggleBtn = target.closest('[data-reminder-toggle]') as HTMLElement | null;
    if (toggleBtn) {
      toggleCompletion(parseInt(toggleBtn.dataset.reminderToggle!));
      return;
    }

    const editBtn = target.closest('[data-reminder-edit]') as HTMLElement | null;
    if (editBtn) {
      openReminderModal(parseInt(editBtn.dataset.reminderEdit!));
      return;
    }
  });

  // All reminders list interactions
  $id('reminderManageList').addEventListener('click', (e) => {
    const editBtn = (e.target as HTMLElement).closest('[data-manage-edit]') as HTMLElement | null;
    if (editBtn) {
      openReminderModal(parseInt(editBtn.dataset.manageEdit!));
    }
  });

  // Modal events
  $id('reminderModal').addEventListener('click', (e) => {
    if (e.target === $id('reminderModal')) closeReminderModal();
  });

  $id('reminderSaveBtn').addEventListener('click', saveReminder);
  $id('reminderCancelBtn').addEventListener('click', closeReminderModal);
  $id('reminderDeleteBtn').addEventListener('click', deleteReminder);

  // Day picker in modal
  $id('reminderDayPickers').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-reminder-day]') as HTMLElement | null;
    if (btn) {
      const day = parseInt(btn.dataset.reminderDay!);
      if (selectedDays.includes(day)) {
        selectedDays = selectedDays.filter(d => d !== day);
      } else {
        selectedDays.push(day);
      }
      renderReminderDayPickers();
    }
  });

  // Request notification permission on first interaction
  document.addEventListener('click', requestNotificationPermission, { once: true });

  // Reschedule reminders when app regains focus (timers die when backgrounded)
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;

    const dateChanged = getTodayDate() !== lastScheduledDate;

    if (dateChanged) {
      // Day rolled over — reload completions from DB and re-render
      await state.loadReminders();
      renderReminders();
    }

    // Reschedule and fire any missed reminders
    scheduleReminders(true);
  });
}

function renderManageList(): void {
  const el = $id('reminderManageList');
  if (!el) return;
  if (state.reminders.length === 0) {
    el.innerHTML = '<p class="reminder-empty">No reminders created yet</p>';
    return;
  }
  el.innerHTML = state.reminders.map((r, i) =>
    `<div class="reminder-manage-item">
      <span class="reminder-icon">${r.icon || '💊'}</span>
      <div class="reminder-info">
        <span class="reminder-name">${r.name}</span>
        <span class="reminder-time">${fmtTime(r.time)} · ${r.days.map(d => DAYS[d]).join(', ')}</span>
      </div>
      <button class="reminder-edit-btn" data-manage-edit="${i}">Edit</button>
    </div>`
  ).join('');
}

function requestNotificationPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}
