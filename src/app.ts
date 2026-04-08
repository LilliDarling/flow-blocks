import './app.css';
import { state } from './state.js';
import {
  $id, EnergyTier, ENERGY_TIER_VALUE, ENERGY_FIT,
  energySuggestion, valueToTier, fmtTime, addMinutes, getTodayIndex, getTodayDate,
  FlowBlock, TYPE_LABELS, esc,
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
import { initEvents, emit, startSyncLoop, stopSyncLoop } from './events.js';
import { renderDayInsights, renderPatternInsights, initInsightEvents, invalidateInsightCache } from './insights.js';
import { initQuickStart } from './quickstart.js';

type TabName = 'day' | 'week' | 'routines' | 'pomo' | 'energy' | 'tips';
const TAB_ORDER: TabName[] = ['day', 'week', 'routines', 'pomo', 'energy', 'tips'];

// --- Energy check-in (gentle return nudge) ---
const RETURN_NUDGE_MS = 3 * 60 * 60 * 1000; // 3 hours away before nudging
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
  if (tab === 'energy') { renderEnergyAnalytics(); renderPatternInsights(); }
}

// --- Energy tier UI ---

function setEnergyTier(tier: EnergyTier, log = true): void {
  const value = ENERGY_TIER_VALUE[tier];
  state.energy = value;

  // Highlight active button (clear first so re-selecting the same tier is visible)
  document.querySelectorAll<HTMLElement>('.energy-check .energy-btn').forEach(btn => {
    btn.classList.remove('active', 'energy-confirmed');
  });
  // Force reflow so removing + re-adding classes triggers animation
  void ($id('energyButtons') as HTMLElement).offsetWidth;
  document.querySelectorAll<HTMLElement>('.energy-check .energy-btn').forEach(btn => {
    if (btn.dataset.energy === tier) {
      btn.classList.add('active');
      if (log) btn.classList.add('energy-confirmed');
    }
  });

  // Update suggestion banner
  const banner = $id('energySuggestion');
  banner.textContent = energySuggestion(value);
  banner.className = 'energy-suggestion ' + (tier === 'low' ? 'low' : tier === 'med' ? 'mid' : 'high');

  // Re-render timeline so block highlights update
  renderTimeline();
  renderDayInsights();

  if (log) {
    state.logEnergy(value);
    lastEnergyLogTime = Date.now();
    hideCheckinToast();
    showReorderSuggestion(value);
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
      <strong>${esc(betterLabel)}</strong> (${fmtTime(betterBlock.start)}) might be a better fit —
      swap it with <strong>${esc(nextLabel)}</strong> (${fmtTime(nextBlock.start)})?
    </div>
    <div class="reorder-suggestion-actions">
      <button class="btn btn-primary" id="reorderAccept">Swap them</button>
      <button class="btn btn-ghost" id="reorderDismiss">Keep as is</button>
    </div>`;
  container.style.display = 'block';

  // Capture IDs so the swap survives state.refresh() replacing block references
  const nextId = nextBlock.id;
  const betterId = betterBlock.id;
  const nextStart = nextBlock.start;
  const betterStart = betterBlock.start;

  $id('reorderAccept').addEventListener('click', async () => {
    // Look up blocks by ID — references may be stale after a refresh
    const nextIdx = state.blocks.findIndex(b => b.id === nextId);
    const betterIdx = state.blocks.findIndex(b => b.id === betterId);
    if (nextIdx >= 0 && betterIdx >= 0) {
      const currNext = state.blocks[nextIdx];
      const currBetter = state.blocks[betterIdx];
      await state.updateBlock(nextIdx, { ...currNext, start: betterStart }, 'reorder_suggestion');
      await state.updateBlock(betterIdx, { ...currBetter, start: nextStart }, 'reorder_suggestion');
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

/** Show the energy check-in toast only during daytime hours. */
function showCheckinToast(): void {
  const h = new Date().getHours();
  if (h < 9 || h >= 21) return; // outside 9AM-9PM — don't interrupt
  $id('energyCheckinToast').style.display = 'flex';
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
  initInsightEvents();
  initQuickStart();

  // Legal page navigation
  initLegalLinks();
}

let uiInitialized = false;

async function onUserSignedIn(userId: string): Promise<void> {
  // Load all data while splash screen is still visible
  await state.load(userId);

  // Initialize event system (IDB queue + sync loop)
  await initEvents();
  emit({ type: 'app.session_started', entity_type: null, payload: {} });

  // Restore energy tier from last logged value
  const tier = valueToTier(state.energy);

  if (!uiInitialized) {
    initUI();
    uiInitialized = true;
  }

  setEnergyTier(tier, false);

  // Clear button highlight so re-selecting the same level gives visual feedback
  document.querySelectorAll<HTMLElement>('.energy-check .energy-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  // Track last energy log time for return-nudge logic
  if (state.energyLogs.length > 0) {
    const lastLog = state.energyLogs[state.energyLogs.length - 1];
    lastEnergyLogTime = new Date(lastLog.logged_at).getTime();
  }

  // Check if we're returning from a calendar OAuth redirect
  await state.checkCalendarRedirect();

  renderTimeline();
  renderReminders();
  scheduleReminders();
  renderDayInsights();

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

// Track when app goes hidden for away-duration calculation
let lastHiddenAt = 0;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    lastHiddenAt = Date.now();
    stopSyncLoop();
  }
});

// Re-sync all state when app regains focus (handles cross-tab / cross-device)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (!state.userId) return;

  // Resume event sync and emit session resumed
  startSyncLoop();
  if (lastHiddenAt > 0) {
    const awaySeconds = Math.round((Date.now() - lastHiddenAt) / 1000);
    emit({ type: 'app.session_resumed', entity_type: null, payload: { away_duration_seconds: awaySeconds } });
  }

  await state.refresh();

  // Sync energy UI from refreshed data
  const tier = valueToTier(state.energy);
  setEnergyTier(tier, false);

  if (state.energyLogs.length > 0) {
    const lastLog = state.energyLogs[state.energyLogs.length - 1];
    lastEnergyLogTime = new Date(lastLog.logged_at).getTime();
  }

  // Gentle nudge only when returning after a long absence
  const awayMs = lastHiddenAt > 0 ? Date.now() - lastHiddenAt : 0;
  const sinceLastLog = Date.now() - lastEnergyLogTime;
  if (awayMs >= RETURN_NUDGE_MS && sinceLastLog >= RETURN_NUDGE_MS) {
    showCheckinToast();
  } else {
    hideCheckinToast();
  }

  // Re-render the active view
  renderTimeline();
  renderReminders();
  invalidateInsightCache();
  renderDayInsights();
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

  onAuth(async (userId) => {
    if (userId) {
      onUserSignedIn(userId);
    } else {
      // User signed out — clear event queue to prevent cross-user data leaks
      const { clearEventQueue } = await import('./events.js');
      clearEventQueue();
    }
  });
});
