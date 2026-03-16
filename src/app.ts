import { state } from './state.js';
import { $id, energySuggestion } from './utils.js';
import { renderTimeline, initTimelineEvents } from './timeline.js';
import { renderWeek, initWeekEvents } from './week.js';
import { renderEnergyAnalytics } from './energy.js';
import { openModal, initModalEvents } from './modal.js';
import { initPomodoro } from './pomodoro.js';
import { initAuth, onAuth, showApp } from './auth.js';
import { initCalendarUI } from './calendar/ui.js';
import { showCalendarSyncDialog } from './calendar/sync.js';
import { initDragAndDrop } from './drag.js';
import { renderReminders, initReminderEvents, scheduleReminders } from './routines.js';
import { initDeleteConfirmEvents } from './confirm-delete.js';
import { initPWA } from './pwa.js';

type TabName = 'day' | 'week' | 'routines' | 'pomo' | 'energy' | 'tips';
const TAB_ORDER: TabName[] = ['day', 'week', 'routines', 'pomo', 'energy', 'tips'];

function switchTab(tab: TabName): void {
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', TAB_ORDER[i] === tab);
  });
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $id(tab + '-view').classList.add('active');

  if (tab === 'day') renderTimeline();
  if (tab === 'week') renderWeek();
  if (tab === 'routines') renderReminders();
  if (tab === 'energy') renderEnergyAnalytics();
}

function updateEnergyUI(val: string): void {
  const v = parseInt(val);
  state.energy = v;

  // Update value display
  const el = $id('energyVal');
  el.textContent = val;
  if (v <= 3) el.style.color = '#ef4444';
  else if (v <= 6) el.style.color = '#f59e0b';
  else el.style.color = '#34d399';

  // Update suggestion banner
  const banner = $id('energySuggestion');
  banner.textContent = energySuggestion(v);
  banner.className = 'energy-suggestion ' + (v <= 3 ? 'low' : v <= 6 ? 'mid' : 'high');

  // Re-render timeline so block highlights update
  renderTimeline();
}

let energyLogTimeout: ReturnType<typeof setTimeout> | null = null;
let lastLoggedEnergy: number | null = null;
function logEnergy(value: number): void {
  if (energyLogTimeout) clearTimeout(energyLogTimeout);
  energyLogTimeout = setTimeout(() => {
    if (value !== lastLoggedEnergy) {
      lastLoggedEnergy = value;
      state.logEnergy(value);
    }
  }, 2000);
}

function initUI(): void {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => switchTab(TAB_ORDER[i]));
  });

  // Energy slider — 'input' for live UI updates, 'change' for DB logging
  const slider = $id('energySlider') as HTMLInputElement;
  slider.addEventListener('input', () => updateEnergyUI(slider.value));
  slider.addEventListener('change', () => logEnergy(parseInt(slider.value)));
  updateEnergyUI(slider.value);

  // Add block button
  $id('addBlockBtn').addEventListener('click', () => openModal());

  // Event listeners for feature modules
  initTimelineEvents();
  initDragAndDrop();
  initWeekEvents();
  initModalEvents();
  initPomodoro();
  initReminderEvents();
  initDeleteConfirmEvents();
  initCalendarUI();
}

let uiInitialized = false;

async function onUserSignedIn(userId: string): Promise<void> {
  // Load all data while splash screen is still visible
  await state.load(userId);

  // Restore energy slider to last logged value before initUI reads it
  const slider = $id('energySlider') as HTMLInputElement;
  slider.value = String(state.energy);
  lastLoggedEnergy = state.energy;

  if (!uiInitialized) {
    initUI();
    uiInitialized = true;
  } else {
    updateEnergyUI(slider.value);
  }

  // Check if we're returning from a calendar OAuth redirect
  await state.checkCalendarRedirect();

  renderTimeline();
  renderReminders();
  scheduleReminders();

  // Data is loaded — now reveal the app (hides splash)
  showApp();

  // Show sync dialog if there are calendar events to review
  if (state.calendarEvents.length > 0) {
    showCalendarSyncDialog();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initPWA();
  initAuth();

  onAuth((userId) => {
    if (userId) {
      onUserSignedIn(userId);
    }
  });
});
