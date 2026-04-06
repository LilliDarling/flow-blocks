import { state } from './state.js';
import { DAYS, Reminder, ReminderTimeSuggestion, fmtTime, getTodayIndex, getTodayDate, $id, esc } from './utils.js';
import { confirmDelete } from './confirm-delete.js';
import { requestNotificationPermission, subscribeToPush } from './push.js';

const DEFAULT_ICON = '💊';

let editingReminderIndex = -1;
let selectedDays: number[] = [];
let reminderTimers: ReturnType<typeof setTimeout>[] = [];
let lastScheduledDate: string = '';

export function renderReminders(): void {
  const dayIndex = getTodayIndex();

  // --- Today's reminders ---
  const todayReminders = state.reminders.filter(r => r.days.includes(dayIndex));
  const activeReminders = todayReminders.filter(r => !state.isReminderSkippedToday(r));
  const completedCount = activeReminders.filter(r => state.isReminderCompletedToday(r)).length;
  const totalCount = activeReminders.length;

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
        const skipped = state.isReminderSkippedToday(r);
        const cssClass = skipped ? 'reminder-skipped' : done ? 'reminder-done' : '';
        return `<div class="reminder-item ${cssClass}" data-reminder-idx="${realIndex}">
          <button class="reminder-check" data-reminder-toggle="${realIndex}">${done ? '✓' : ''}</button>
          <span class="reminder-icon">${esc(r.icon || '💊')}</span>
          <div class="reminder-info">
            <span class="reminder-name">${esc(r.name)}</span>
            <span class="reminder-time">${fmtTime(r.time)}</span>
          </div>
          <button class="reminder-skip-btn" data-reminder-skip="${realIndex}">${skipped ? 'Undo' : 'Skip'}</button>
          <button class="reminder-edit-btn" data-reminder-edit="${realIndex}">Edit</button>
        </div>`;
      }).join('')
    : `<p class="reminder-empty">No reminders scheduled for today — tap "+ Add Reminder" to create one</p>`;

  $id('remindersList').innerHTML = progressHtml + listHtml;

  // --- Time suggestions ---
  renderTimeSuggestions();

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
    if (state.isReminderSkippedToday(reminder)) continue;

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
    icon: '/icons/icon.png',
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
    // Skip this occurrence for today
    if (!state.isReminderSkippedToday(reminder)) {
      await state.toggleReminderSkip(reminder);
    }
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

async function skipReminder(index: number): Promise<void> {
  const reminder = state.reminders[index];
  if (!reminder) return;
  await state.toggleReminderSkip(reminder);
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

    const skipBtn = target.closest('[data-reminder-skip]') as HTMLElement | null;
    if (skipBtn) {
      skipReminder(parseInt(skipBtn.dataset.reminderSkip!));
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

  // Suggestion card interactions (confirm / keep)
  $id('reminderSuggestions').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const confirmBtn = target.closest('[data-confirm-id]') as HTMLElement | null;
    if (confirmBtn) {
      acceptTimeSuggestion(confirmBtn.dataset.confirmId!, confirmBtn.dataset.newTime!);
      return;
    }

    const keepBtn = target.closest('[data-keep-id]') as HTMLElement | null;
    if (keepBtn) {
      dismissTimeSuggestion(keepBtn.dataset.keepId!);
      return;
    }
  });

  // Notification opt-in banner
  updateNotifBanner();
  $id('notifOptInBtn').addEventListener('click', async () => {
    const granted = await requestNotificationPermission();
    if (granted && state.userId) subscribeToPush(state.userId);
    updateNotifBanner();
  });
  $id('notifOptInDismiss').addEventListener('click', () => {
    $id('notifOptIn').style.display = 'none';
    sessionStorage.setItem('notif_dismissed', '1');
  });

  // Request notification permission on first interaction
  document.addEventListener('click', async () => {
    const granted = await requestNotificationPermission();
    if (granted && state.userId) subscribeToPush(state.userId);
    updateNotifBanner();
  }, { once: true });

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

function renderTimeSuggestions(): void {
  const container = $id('reminderSuggestions');
  if (!container) return;

  const suggestions = state.getReminderTimeSuggestions();
  if (suggestions.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="reminder-suggestions-header">
      <h4>Suggested Time Adjustments</h4>
      <p class="reminder-suggestions-sub">Based on your last 7 days of activity</p>
    </div>
    ${suggestions.map(s => `
      <div class="reminder-suggestion-card" data-suggestion-id="${esc(s.reminderId)}">
        <div class="suggestion-info">
          <span class="reminder-icon">${esc(s.reminderIcon)}</span>
          <div>
            <span class="suggestion-name">${esc(s.reminderName)}</span>
            <span class="suggestion-detail">
              Scheduled at <strong>${fmtTime(s.scheduledTime)}</strong> — you usually complete it around <strong>${fmtTime(s.avgCompletionTime)}</strong>
            </span>
            <span class="suggestion-detail suggestion-data-points">${s.dataPoints} data points over 7 days</span>
          </div>
        </div>
        <div class="suggestion-actions">
          <button class="btn btn-primary suggestion-confirm-btn" data-confirm-id="${esc(s.reminderId)}" data-new-time="${esc(s.suggestedTime)}">
            Switch to ${fmtTime(s.suggestedTime)}
          </button>
          <button class="btn btn-ghost suggestion-keep-btn" data-keep-id="${esc(s.reminderId)}">
            Keep as is
          </button>
        </div>
      </div>
    `).join('')}`;
}

async function acceptTimeSuggestion(reminderId: string, newTime: string): Promise<void> {
  const index = state.reminders.findIndex(r => r.id === reminderId);
  if (index < 0) return;

  const reminder = state.reminders[index];
  await state.updateReminder(index, { ...reminder, time: newTime }, 'time_suggestion');
  state.dismissedSuggestions.add(reminderId);
  renderReminders();
  scheduleReminders();
}

function dismissTimeSuggestion(reminderId: string): void {
  state.dismissedSuggestions.add(reminderId);
  renderTimeSuggestions();
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
      <span class="reminder-icon">${esc(r.icon || '💊')}</span>
      <div class="reminder-info">
        <span class="reminder-name">${esc(r.name)}</span>
        <span class="reminder-time">${fmtTime(r.time)} · ${r.days.map(d => DAYS[d]).join(', ')}</span>
      </div>
      <button class="reminder-edit-btn" data-manage-edit="${i}">Edit</button>
    </div>`
  ).join('');
}

function updateNotifBanner(): void {
  const banner = $id('notifOptIn');
  const show = 'Notification' in window
    && Notification.permission === 'default'
    && !sessionStorage.getItem('notif_dismissed');
  banner.style.display = show ? 'flex' : 'none';
}
