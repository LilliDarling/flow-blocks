import { state } from './state.js';
import { $id, energySuggestion } from './utils.js';
import { renderTimeline, initTimelineEvents } from './timeline.js';
import { renderWeek, initWeekEvents } from './week.js';
import { renderEnergyAnalytics } from './energy.js';
import { openModal, initModalEvents } from './modal.js';
import { initPomodoro } from './pomodoro.js';
import { initAuth, onAuth } from './auth.js';
import { initCalendarUI } from './calendar/ui.js';
import { showCalendarSyncDialog } from './calendar/sync.js';

type TabName = 'day' | 'week' | 'pomo' | 'energy' | 'tips';
const TAB_ORDER: TabName[] = ['day', 'week', 'pomo', 'energy', 'tips'];

function switchTab(tab: TabName): void {
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', TAB_ORDER[i] === tab);
  });
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $id(tab + '-view').classList.add('active');

  if (tab === 'day') renderTimeline();
  if (tab === 'week') renderWeek();
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
  initWeekEvents();
  initModalEvents();
  initPomodoro();
  initCalendarUI();
}

let uiInitialized = false;

async function onUserSignedIn(userId: string): Promise<void> {
  await state.load(userId);

  if (!uiInitialized) {
    initUI();
    uiInitialized = true;
  }

  // Check if we're returning from a calendar OAuth redirect
  const wasRedirect = await state.checkCalendarRedirect();

  renderTimeline();

  // Show sync dialog if there are calendar events to review
  if (state.calendarEvents.length > 0) {
    showCalendarSyncDialog();
  }
}

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

document.addEventListener('DOMContentLoaded', () => {
  initAuth();

  onAuth((userId) => {
    if (userId) {
      onUserSignedIn(userId);
    }
  });
});
