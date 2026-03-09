import { state } from './state.js';
import { $id } from './utils.js';
import { renderTimeline, initTimelineEvents } from './timeline.js';
import { renderWeek, initWeekEvents } from './week.js';
import { openModal, initModalEvents } from './modal.js';
import { initPomodoro } from './pomodoro.js';
import { initAuth, onAuth } from './auth.js';

type TabName = 'day' | 'week' | 'pomo' | 'tips';
const TAB_ORDER: TabName[] = ['day', 'week', 'pomo', 'tips'];

function switchTab(tab: TabName): void {
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', TAB_ORDER[i] === tab);
  });
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $id(tab + '-view').classList.add('active');

  if (tab === 'day') renderTimeline();
  if (tab === 'week') renderWeek();
}

function updateEnergy(val: string): void {
  const el = $id('energyVal');
  el.textContent = val;
  const v = parseInt(val);
  if (v <= 3) el.style.color = '#ef4444';
  else if (v <= 6) el.style.color = '#f59e0b';
  else el.style.color = '#34d399';
}

function initUI(): void {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => switchTab(TAB_ORDER[i]));
  });

  // Energy slider
  const slider = $id('energySlider') as HTMLInputElement;
  slider.addEventListener('input', () => updateEnergy(slider.value));
  updateEnergy(slider.value);

  // Add block button
  $id('addBlockBtn').addEventListener('click', () => openModal());

  // Event listeners for feature modules
  initTimelineEvents();
  initWeekEvents();
  initModalEvents();
  initPomodoro();
}

let uiInitialized = false;

async function onUserSignedIn(userId: string): Promise<void> {
  await state.load(userId);

  if (!uiInitialized) {
    initUI();
    uiInitialized = true;
  }

  renderTimeline();
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
