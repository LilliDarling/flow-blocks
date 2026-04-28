import './app.css';
import { state } from './state.js';
import {
  $id, EnergyTier, ENERGY_TIER_VALUE, ENERGY_FIT,
  energySuggestion, valueToTier, fmtTime, addMinutes, getTodayIndex, getTodayDate,
  FlowBlock, TYPE_LABELS, isScheduled, esc,
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
import { initNative } from './native.js';
import { initEvents, emit, startSyncLoop, stopSyncLoop, onSyncHealthChange, getSyncHealth, SyncHealth } from './events.js';
import { renderDayInsights, renderPatternInsights, initInsightEvents, invalidateInsightCache } from './insights.js';
import { initQuickStart } from './quickstart.js';

type TabName = 'day' | 'week' | 'routines' | 'pomo' | 'energy' | 'tips';
const TAB_ORDER: TabName[] = ['day', 'week', 'routines', 'pomo', 'energy', 'tips'];

// --- Energy check-in ---
const CHECKIN_INTERVAL_MS = 60 * 60 * 1000; // prompt after 1 hour since last log
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
    showPoolPrompt(value);
  }
}

// --- Pool prompt after energy check-in ---

function showPoolPrompt(energy: number): void {
  // Find pool blocks that match the current energy level
  const matches = state.blocks.filter(b => {
    if (isScheduled(b)) return false;
    if (b.status === 'done' || b.status === 'skipped') return false;
    const [eMin, eMax] = ENERGY_FIT[b.type];
    return energy >= eMin && energy <= eMax;
  });
  if (matches.length === 0) return;

  // Pick the first match to highlight
  const top = matches[0];
  const label = top.title || TYPE_LABELS[top.type];
  const others = matches.length - 1;
  const suffix = others > 0 ? ` and ${others} more` : '';

  const prompt = document.createElement('div');
  prompt.className = 'pool-prompt-overlay';
  prompt.innerHTML = `
    <div class="pool-prompt">
      <p class="pool-prompt-text">
        <strong>${esc(label)}</strong>${esc(suffix)} in your pool ${matches.length === 1 ? 'fits' : 'fit'} your energy right now.
      </p>
      <div class="pool-prompt-actions">
        <button class="btn btn-primary pool-prompt-go">Show me</button>
        <button class="btn btn-ghost pool-prompt-dismiss">Later</button>
      </div>
    </div>`;

  document.body.appendChild(prompt);

  prompt.querySelector('.pool-prompt-go')!.addEventListener('click', () => {
    prompt.remove();
    switchTab('day');
    // Scroll to pool section
    const pool = $id('poolSection');
    if (pool) pool.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  prompt.querySelector('.pool-prompt-dismiss')!.addEventListener('click', () => {
    prompt.remove();
  });

  prompt.addEventListener('click', (e) => {
    if (e.target === prompt) prompt.remove();
  });
}

// --- Reorder suggestion (only for pinned/scheduled blocks) ---

function showReorderSuggestion(energy: number): void {
  const container = $id('reorderSuggestion');
  const today = getTodayDate();
  const dayIdx = getTodayIndex();
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

  // Get today's pending *scheduled* blocks that haven't started yet
  const pendingBlocks = state.blocks.filter(b => {
    if (!b.start) return false; // skip pool blocks
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

  const nextBlock = pendingBlocks[0];
  const [eMin, eMax] = ENERGY_FIT[nextBlock.type];
  const isGoodFit = energy >= eMin && energy <= eMax;

  if (isGoodFit) {
    container.style.display = 'none';
    return;
  }

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
      swap with <strong>${esc(nextLabel)}</strong> (${fmtTime(nextBlock.start)})?
    </div>
    <div class="reorder-suggestion-actions">
      <button class="btn btn-primary" id="reorderAccept">Swap them</button>
      <button class="btn btn-ghost" id="reorderDismiss">Keep as is</button>
    </div>`;
  container.style.display = 'block';

  const nextId = nextBlock.id;
  const betterId = betterBlock.id;
  const nextStart = nextBlock.start;
  const betterStart = betterBlock.start;

  $id('reorderAccept').addEventListener('click', async () => {
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

// --- Energy check-in popup ---

let checkinOverlay: HTMLElement | null = null;

/** Show a full-screen energy check-in if 1+ hour has passed since last log.
 *  Only during daytime hours (9AM-9PM). */
function maybeShowCheckinPopup(): void {
  const h = new Date().getHours();
  if (h < 9 || h >= 21) return;

  const sinceLastLog = Date.now() - lastEnergyLogTime;
  if (lastEnergyLogTime > 0 && sinceLastLog < CHECKIN_INTERVAL_MS) return;

  showCheckinPopup();
}

function showCheckinPopup(): void {
  if (checkinOverlay) return; // already showing

  checkinOverlay = document.createElement('div');
  checkinOverlay.className = 'checkin-popup-overlay';
  checkinOverlay.innerHTML = `
    <div class="checkin-popup">
      <p class="checkin-popup-greeting">${getCheckinGreeting()}</p>
      <p class="checkin-popup-question">How's your energy right now?</p>
      <div class="checkin-popup-buttons">
        <button class="checkin-popup-btn energy-low" data-tier="low">
          <span class="checkin-popup-label">Low</span>
          <span class="checkin-popup-desc">Foggy, tired, need easy wins</span>
        </button>
        <button class="checkin-popup-btn energy-med" data-tier="med">
          <span class="checkin-popup-label">Med</span>
          <span class="checkin-popup-desc">Some energy, want to move</span>
        </button>
        <button class="checkin-popup-btn energy-high" data-tier="high">
          <span class="checkin-popup-label">High</span>
          <span class="checkin-popup-desc">Focused, ready to go</span>
        </button>
      </div>
      <button class="checkin-popup-skip">Skip for now</button>
    </div>`;

  document.body.appendChild(checkinOverlay);

  checkinOverlay.querySelectorAll<HTMLElement>('[data-tier]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tier = btn.dataset.tier as EnergyTier;
      dismissCheckinPopup();
      setEnergyTier(tier);
    });
  });

  checkinOverlay.querySelector('.checkin-popup-skip')!.addEventListener('click', () => {
    dismissCheckinPopup();
  });
}

function dismissCheckinPopup(): void {
  if (checkinOverlay) {
    checkinOverlay.remove();
    checkinOverlay = null;
  }
  // Also hide the old toast if it's showing
  const toast = $id('energyCheckinToast');
  if (toast) toast.style.display = 'none';
}

function getCheckinGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// Keep old toast functions for notification-triggered check-ins
function showCheckinToast(): void {
  const h = new Date().getHours();
  if (h < 9 || h >= 21) return;
  showCheckinPopup(); // upgrade toast to popup
}

function hideCheckinToast(): void {
  dismissCheckinPopup();
}

// --- Quick complete / skip from notifications ---

async function handleQuickComplete(blockId: string): Promise<void> {
  const idx = state.blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return;
  const block = state.blocks[idx];
  const title = block.title || TYPE_LABELS[block.type] + ' block';
  await state.updateBlockStatus(idx, 'done');
  await state.addDoneItem(title, undefined, blockId);
  state.invalidateStreakCache();
  renderTimeline();
  renderWeek();
}

async function handleQuickSkip(blockId: string): Promise<void> {
  const idx = state.blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return;
  await state.updateBlockStatus(idx, 'skipped');
  renderTimeline();
  renderWeek();
}

// --- Streak ---

// --- Sync health indicator ---

function formatAgo(ms: number | null): string {
  if (ms == null) return 'never';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} day${Math.floor(s / 86400) === 1 ? '' : 's'} ago`;
}

function applySyncHealth(h: SyncHealth): void {
  const btn = document.getElementById('syncHealthBtn') as HTMLElement | null;
  if (!btn) return;
  btn.style.display = h.stuck ? '' : 'none';
  const lines = [
    `${h.queueSize} event${h.queueSize === 1 ? '' : 's'} waiting to sync`,
    `Last successful sync: ${formatAgo(h.lastSuccessMs)}`,
    h.lastError ? `Last error: ${h.lastError}` : '',
    h.eventsDroppedAtCap > 0 ? `⚠ ${h.eventsDroppedAtCap} event(s) dropped — queue was full` : '',
    '',
    'Check your connection or sign out and back in.',
  ].filter(Boolean);
  btn.title = lines.join('\n');
}

function initSyncHealthIndicator(): void {
  applySyncHealth(getSyncHealth());
  onSyncHealthChange(applySyncHealth);
  const btn = document.getElementById('syncHealthBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      const h = getSyncHealth();
      const msg = [
        `Sync is stuck.`,
        ``,
        `${h.queueSize} events are waiting locally.`,
        `Last successful sync: ${formatAgo(h.lastSuccessMs)}.`,
        h.lastError ? `Last error: ${h.lastError}` : '',
        h.eventsDroppedAtCap > 0 ? `⚠ ${h.eventsDroppedAtCap} event(s) have been dropped — the queue filled up.` : '',
        ``,
        `Try: check your connection, refresh the page, or sign out and back in. Your queued events will sync once sync is working again.`,
      ].filter(Boolean).join('\n');
      alert(msg);
    });
  }
}

async function renderStreak(): Promise<void> {
  const badge = $id('streakBadge');
  if (!badge) return;
  const streak = await state.computeStreak();
  badge.style.display = '';
  badge.innerHTML = `<span class="streak-count">${streak}</span><span class="streak-label">Day Streak</span>`;
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
  initSyncHealthIndicator();
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

  // Handle notification action query params (when app wasn't open)
  const params = new URLSearchParams(window.location.search);
  const qAction = params.get('action');
  const qBlockId = params.get('blockId');

  if (qAction === 'complete-block' && qBlockId) {
    handleQuickComplete(qBlockId);
    history.replaceState(null, '', '/');
  } else if (qAction === 'skip-block' && qBlockId) {
    handleQuickSkip(qBlockId);
    history.replaceState(null, '', '/');
  } else if (qAction === 'energy-checkin') {
    history.replaceState(null, '', '/');
  }

  // Energy check-in popup on load — only prompt if it's been 1+ hour since
  // the last log (and within the 9 AM – 9 PM window).
  maybeShowCheckinPopup();

  // Show sync dialog if there are calendar events to review
  if (state.calendarEvents.length > 0) {
    showCalendarSyncDialog();
  }

  // Render streak badge (fire-and-forget, doesn't block load)
  renderStreak();
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

  // Check-in popup on return if 1+ hour since last log
  maybeShowCheckinPopup();

  // Re-render the active view
  renderTimeline();
  renderReminders();
  invalidateInsightCache();
  renderDayInsights();
  state.invalidateStreakCache();
  renderStreak();
});

// Listen for messages from service worker (notification clicks while app is open)
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'ENERGY_CHECKIN') {
    showCheckinToast();
  } else if (e.data?.type === 'POMO_COMPLETE') {
    switchTab('pomo');
  } else if (e.data?.type === 'DAILY_REVIEW') {
    switchTab('day');
  } else if (e.data?.type === 'QUICK_COMPLETE' && e.data.blockId) {
    handleQuickComplete(e.data.blockId);
  } else if (e.data?.type === 'QUICK_SKIP' && e.data.blockId) {
    handleQuickSkip(e.data.blockId);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  // initNative is fire-and-forget: it sets up deep-link listeners for OAuth
  // callbacks, configures the status bar, and dismisses the native splash.
  // Must run before initAuth so a freshly-resumed app catches the redirect.
  initNative();
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
