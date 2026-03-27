import './app.css';
import { state } from './state.js';
import {
  $id, EnergyTier, ENERGY_TIER_VALUE, ENERGY_FIT,
  energySuggestion, valueToTier, fmtTime, addMinutes, getTodayIndex, getTodayDate,
  FlowBlock, TYPE_LABELS,
} from './utils.js';
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
import { subscribeToPush } from './push.js';

type TabName = 'day' | 'week' | 'routines' | 'pomo' | 'energy' | 'tips';
const TAB_ORDER: TabName[] = ['day', 'week', 'routines', 'pomo', 'energy', 'tips'];

// --- Energy check-in timer ---
const CHECKIN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
let checkinTimer: ReturnType<typeof setTimeout> | null = null;
let lastEnergyLogTime = 0;

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

// --- Energy tier UI ---

function setEnergyTier(tier: EnergyTier, log = true): void {
  const value = ENERGY_TIER_VALUE[tier];
  state.energy = value;

  // Highlight active button
  document.querySelectorAll<HTMLElement>('.energy-check .energy-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.energy === tier);
  });

  // Update suggestion banner
  const banner = $id('energySuggestion');
  banner.textContent = energySuggestion(value);
  banner.className = 'energy-suggestion ' + (tier === 'low' ? 'low' : tier === 'med' ? 'mid' : 'high');

  // Re-render timeline so block highlights update
  renderTimeline();

  if (log) {
    state.logEnergy(value);
    lastEnergyLogTime = Date.now();
    hideCheckinToast();
    showReorderSuggestion(value);
    scheduleEnergyCheckin();
  }
}

// --- Reorder suggestion ---

function showReorderSuggestion(energy: number): void {
  const container = $id('reorderSuggestion');
  const today = getTodayDate();
  const dayIdx = getTodayIndex();
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

  // Get today's pending blocks that haven't started yet
  const pendingBlocks = state.blocks.filter(b => {
    const isToday = b.date === today || (!b.date && b.days.includes(dayIdx));
    if (!isToday) return false;
    const status = state.getEffectiveStatus(b, today);
    if (status !== 'pending') return false;
    const [h, m] = b.start.split(':').map(Number);
    return h * 60 + m > nowMinutes;
  });

  if (pendingBlocks.length < 2) {
    container.style.display = 'none';
    return;
  }

  // Find the next pending block
  const nextBlock = pendingBlocks[0];
  const [eMin, eMax] = ENERGY_FIT[nextBlock.type];
  const isGoodFit = energy >= eMin && energy <= eMax;

  if (isGoodFit) {
    container.style.display = 'none';
    return;
  }

  // Find a better-fitting block among the remaining pending blocks
  const betterBlock = pendingBlocks.slice(1).find(b => {
    const [bMin, bMax] = ENERGY_FIT[b.type];
    return energy >= bMin && energy <= bMax;
  });

  if (!betterBlock) {
    container.style.display = 'none';
    return;
  }

  const nextLabel = nextBlock.title || TYPE_LABELS[nextBlock.type];
  const betterLabel = betterBlock.title || TYPE_LABELS[betterBlock.type];

  container.innerHTML = `
    <div class="reorder-suggestion-text">
      Your energy is ${valueToTier(energy)} right now.
      <strong>${betterLabel}</strong> (${fmtTime(betterBlock.start)}) might be a better fit —
      swap it with <strong>${nextLabel}</strong> (${fmtTime(nextBlock.start)})?
    </div>
    <div class="reorder-suggestion-actions">
      <button class="btn btn-primary" id="reorderAccept">Swap them</button>
      <button class="btn btn-ghost" id="reorderDismiss">Keep as is</button>
    </div>`;
  container.style.display = 'block';

  $id('reorderAccept').addEventListener('click', async () => {
    // Swap start times
    const nextIdx = state.blocks.indexOf(nextBlock);
    const betterIdx = state.blocks.indexOf(betterBlock);
    if (nextIdx >= 0 && betterIdx >= 0) {
      const tempStart = nextBlock.start;
      await state.updateBlock(nextIdx, { ...nextBlock, start: betterBlock.start });
      await state.updateBlock(betterIdx, { ...betterBlock, start: tempStart });
      renderTimeline();
      renderWeek();
    }
    container.style.display = 'none';
  });

  $id('reorderDismiss').addEventListener('click', () => {
    container.style.display = 'none';
  });
}

// --- Energy check-in toast ---

function scheduleEnergyCheckin(): void {
  if (checkinTimer) clearTimeout(checkinTimer);
  checkinTimer = setTimeout(() => showCheckinToast(), CHECKIN_INTERVAL_MS);
}

function showCheckinToast(): void {
  const h = new Date().getHours();
  if (h < 9 || h >= 21) {
    // Outside 9AM-9PM — schedule for next window
    scheduleEnergyCheckin();
    return;
  }

  const toast = $id('energyCheckinToast');
  toast.style.display = 'flex';
}

function hideCheckinToast(): void {
  const toast = $id('energyCheckinToast');
  if (toast) toast.style.display = 'none';
}

// --- Legal pages ---

function initLegalLinks(): void {
  // Already initialized at module load — this is a no-op placeholder
  // so the call in initUI doesn't break if we add future legal setup.
}

// Legal pages — initialized immediately so links work on auth screen too
(function () {
  const privacyPage = document.getElementById('privacyPage')!;
  const tosPage = document.getElementById('tosPage')!;

  function showLegal(page: HTMLElement, hash: string): void {
    page.style.display = 'block';
    page.scrollTop = 0;
    if (location.hash !== hash) history.pushState(null, '', hash);
  }

  function hideLegal(page: HTMLElement): void {
    page.style.display = 'none';
    if (location.hash === '#privacy' || location.hash === '#tos') history.pushState(null, '', location.pathname);
  }

  function handleHash(): void {
    privacyPage.style.display = location.hash === '#privacy' ? 'block' : 'none';
    tosPage.style.display = location.hash === '#tos' ? 'block' : 'none';
  }

  document.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('[data-legal]') as HTMLElement | null;
    if (!link) return;
    e.preventDefault();
    const isTos = link.dataset.legal === 'tos';
    showLegal(isTos ? tosPage : privacyPage, isTos ? '#tos' : '#privacy');
  });

  document.getElementById('privacyBack')!.addEventListener('click', () => hideLegal(privacyPage));
  document.getElementById('tosBack')!.addEventListener('click', () => hideLegal(tosPage));

  window.addEventListener('hashchange', handleHash);

  // Show legal page if URL already has the hash on load
  handleHash();
})();

// --- Init ---

function initUI(): void {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => switchTab(TAB_ORDER[i]));
  });

  // Energy tier buttons
  $id('energyButtons').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-energy]') as HTMLElement | null;
    if (btn) setEnergyTier(btn.dataset.energy as EnergyTier);
  });

  // Energy check-in toast buttons
  $id('energyCheckinToast').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-checkin]') as HTMLElement | null;
    if (btn) setEnergyTier(btn.dataset.checkin as EnergyTier);
  });
  $id('checkinDismiss').addEventListener('click', () => {
    hideCheckinToast();
    scheduleEnergyCheckin();
  });

  // Add block button
  $id('addBlockBtn').addEventListener('click', () => openModal());

  // Theme toggle
  $id('themeToggleBtn').addEventListener('click', () => {
    const isLight = document.documentElement.classList.toggle('light');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
  });

  // Event listeners for feature modules
  initTimelineEvents();
  initDragAndDrop();
  initWeekEvents();
  initModalEvents();
  initPomodoro();
  initReminderEvents();
  initDeleteConfirmEvents();
  initCalendarUI();

  // Legal page navigation
  initLegalLinks();
}

let uiInitialized = false;

async function onUserSignedIn(userId: string): Promise<void> {
  // Load all data while splash screen is still visible
  await state.load(userId);

  // Restore energy tier from last logged value
  const tier = valueToTier(state.energy);

  if (!uiInitialized) {
    initUI();
    uiInitialized = true;
  }

  setEnergyTier(tier, false);

  // Determine last energy log time for check-in scheduling
  if (state.energyLogs.length > 0) {
    const lastLog = state.energyLogs[state.energyLogs.length - 1];
    lastEnergyLogTime = new Date(lastLog.logged_at).getTime();
  }

  // Schedule first energy check-in based on time since last log
  const elapsed = Date.now() - lastEnergyLogTime;
  if (elapsed >= CHECKIN_INTERVAL_MS) {
    // It's been 2+ hours — prompt soon (10 seconds after load)
    checkinTimer = setTimeout(() => showCheckinToast(), 10_000);
  } else {
    checkinTimer = setTimeout(() => showCheckinToast(), CHECKIN_INTERVAL_MS - elapsed);
  }

  // Check if we're returning from a calendar OAuth redirect
  await state.checkCalendarRedirect();

  renderTimeline();
  renderReminders();
  scheduleReminders();

  // Data is loaded — now reveal the app (hides splash)
  showApp();

  // Register push subscription (fire-and-forget)
  subscribeToPush(userId);

  // Handle energy check-in opened from push notification URL
  const params = new URLSearchParams(window.location.search);
  if (params.get('action') === 'energy-checkin') {
    showCheckinToast();
    history.replaceState(null, '', '/');
  }

  // Show sync dialog if there are calendar events to review
  if (state.calendarEvents.length > 0) {
    showCalendarSyncDialog();
  }
}

// Re-sync all state when app regains focus (handles cross-tab / cross-device)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (!state.userId) return;

  await state.refresh();

  // Sync energy UI + check-in timer from refreshed data
  const tier = valueToTier(state.energy);
  setEnergyTier(tier, false);

  if (state.energyLogs.length > 0) {
    const lastLog = state.energyLogs[state.energyLogs.length - 1];
    lastEnergyLogTime = new Date(lastLog.logged_at).getTime();
  }

  const elapsed = Date.now() - lastEnergyLogTime;
  if (elapsed >= CHECKIN_INTERVAL_MS) {
    showCheckinToast();
  } else {
    hideCheckinToast();
    if (checkinTimer) clearTimeout(checkinTimer);
    checkinTimer = setTimeout(() => showCheckinToast(), CHECKIN_INTERVAL_MS - elapsed);
  }

  // Re-render the active view
  renderTimeline();
  renderReminders();
});

// Listen for messages from service worker (notification clicks while app is open)
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'ENERGY_CHECKIN') {
    showCheckinToast();
  } else if (e.data?.type === 'POMO_COMPLETE') {
    switchTab('pomo');
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initPWA();
  initAuth();

  onAuth((userId) => {
    if (userId) {
      onUserSignedIn(userId);
    }
  });
});
