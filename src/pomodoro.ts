import { state } from './state.js';
import { PomoMode, $id } from './utils.js';

const RING_CIRCUMFERENCE = 2 * Math.PI * 124;
const POMO_MODES: PomoMode[] = ['focus', 'short', 'long'];
const STORAGE_KEY = 'pomo_timer';

/** Persisted timer state for surviving refresh / background */
interface TimerSnapshot {
  mode: PomoMode;
  totalSeconds: number;
  startedAt: number;    // Date.now() when timer was started
  pausedRemaining: number | null; // seconds left if paused, null if running
  task: string;
  distractions: number;
}

let currentTask = '';
let distractionCount = 0;
let autoStartBreaks = false;
let tickInterval: ReturnType<typeof setInterval> | null = null;

// --- Persistence ---

function saveTimer(): void {
  const { pomo } = state;
  if (!pomo.running && pomo.secondsLeft === pomo.totalSeconds) {
    // Timer is idle / reset — clear storage
    sessionStorage.removeItem(STORAGE_KEY);
    return;
  }

  const snap: TimerSnapshot = {
    mode: pomo.mode,
    totalSeconds: pomo.totalSeconds,
    startedAt: pomo.running
      ? Date.now() - (pomo.totalSeconds - pomo.secondsLeft) * 1000
      : 0,
    pausedRemaining: pomo.running ? null : pomo.secondsLeft,
    task: currentTask,
    distractions: distractionCount,
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
}

function restoreTimer(): boolean {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return false;

  try {
    const snap: TimerSnapshot = JSON.parse(raw);
    const { pomo } = state;

    pomo.mode = snap.mode;
    pomo.totalSeconds = snap.totalSeconds;
    currentTask = snap.task;
    distractionCount = snap.distractions;

    if (snap.pausedRemaining !== null) {
      // Was paused
      pomo.secondsLeft = snap.pausedRemaining;
      pomo.running = false;
    } else {
      // Was running — calculate how much time has elapsed
      const elapsed = Math.floor((Date.now() - snap.startedAt) / 1000);
      const remaining = snap.totalSeconds - elapsed;

      if (remaining <= 0) {
        // Timer completed while we were away
        pomo.secondsLeft = 0;
        pomo.running = false;
        sessionStorage.removeItem(STORAGE_KEY);
        // Defer completion so UI is ready
        setTimeout(() => complete(), 100);
        return true;
      }

      pomo.secondsLeft = remaining;
      pomo.running = true;
      startTicking();
    }

    return true;
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return false;
  }
}

function clearTimerStorage(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

// --- Notifications ---

async function requestNotificationPermission(): Promise<void> {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function sendNotification(title: string, body: string): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      body,
      icon: '/icons/icon.svg',
      tag: 'pomo-complete',
    });
    // Auto-close after 10s
    setTimeout(() => n.close(), 10000);
  } catch { /* ignore */ }
}

// --- Rendering ---

function getColor(): string {
  if (state.pomo.mode === 'focus') return 'url(#pomoGrad)';
  if (state.pomo.mode === 'short') return '#34d399';
  return '#a78bfa';
}

function getLabel(): string {
  if (state.pomo.mode === 'focus') return 'Focus time';
  if (state.pomo.mode === 'short') return 'Short break';
  return 'Long break';
}

function syncSettingsFromInputs(): void {
  const { settings } = state.pomo;
  settings.focus = parseInt(($id('pomoFocusDur') as HTMLInputElement).value) || settings.focus;
  settings.short = parseInt(($id('pomoShortDur') as HTMLInputElement).value) || settings.short;
  settings.long = parseInt(($id('pomoLongDur') as HTMLInputElement).value) || settings.long;
  settings.longAfter = parseInt(($id('pomoLongAfter') as HTMLInputElement).value) || settings.longAfter;
}

function getDuration(mode: PomoMode): number {
  // Always read from HTML inputs to stay in sync with what the user sees
  if (mode === 'focus') return parseInt(($id('pomoFocusDur') as HTMLInputElement).value) || state.pomo.settings.focus;
  if (mode === 'short') return parseInt(($id('pomoShortDur') as HTMLInputElement).value) || state.pomo.settings.short;
  return parseInt(($id('pomoLongDur') as HTMLInputElement).value) || state.pomo.settings.long;
}

function render(): void {
  const { pomo } = state;
  const mins = Math.floor(pomo.secondsLeft / 60);
  const secs = pomo.secondsLeft % 60;
  const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

  $id('pomoDigits').textContent = timeStr;
  $id('pomoPhase').textContent = getLabel();

  // Ring progress
  const ring = $id('pomoRing') as unknown as SVGCircleElement;
  const progress = pomo.totalSeconds > 0 ? pomo.secondsLeft / pomo.totalSeconds : 1;
  ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
  ring.style.stroke = getColor();

  // Pulse animation on ring container
  const ringContainer = $id('pomoRingContainer');
  ringContainer.classList.toggle('pomo-active', pomo.running);
  ringContainer.classList.toggle('pomo-focus-active', pomo.running && pomo.mode === 'focus');
  ringContainer.classList.toggle('pomo-break-active', pomo.running && pomo.mode !== 'focus');

  // Play/pause
  $id('pomoPlayBtn').textContent = pomo.running ? '⏸' : '▶';

  // Stats
  $id('pomoCount').textContent = String(pomo.completedPomos);
  $id('pomoFocusMin').textContent = String(pomo.focusMinutes);
  $id('pomoStreak').textContent = String(pomo.streak);

  // Mode buttons
  document.querySelectorAll<HTMLElement>('.pomo-mode-btn').forEach((btn, i) => {
    btn.classList.toggle('active', POMO_MODES[i] === pomo.mode);
  });

  // Task prompt visibility
  const taskPrompt = $id('pomoTaskPrompt');
  const currentTaskEl = $id('pomoCurrentTask');
  if (pomo.mode === 'focus' && !pomo.running && pomo.secondsLeft === pomo.totalSeconds) {
    taskPrompt.style.display = '';
    currentTaskEl.style.display = 'none';
  } else if (currentTask && pomo.mode === 'focus') {
    taskPrompt.style.display = 'none';
    currentTaskEl.style.display = '';
    $id('pomoTaskText').textContent = currentTask;
  } else {
    taskPrompt.style.display = 'none';
    currentTaskEl.style.display = 'none';
  }

  // Distraction counter visibility (only during active focus)
  const distractionEl = $id('pomoDistraction');
  distractionEl.style.display = (pomo.running && pomo.mode === 'focus') ? '' : 'none';
  $id('pomoDistractionCount').textContent =
    distractionCount === 0 ? '0 distractions' :
    distractionCount === 1 ? '1 distraction' :
    `${distractionCount} distractions`;

  // Page title
  document.title = pomo.running
    ? `${timeStr} — ${getLabel()}`
    : 'Flow Blocks — ADHD-Friendly Time Blocker';
}

function playSound(): void {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.2);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.2 + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.2);
      osc.stop(ctx.currentTime + i * 0.2 + 0.5);
    });
  } catch { /* ignore audio errors */ }
}

function celebrate(): void {
  const container = $id('pomoRingContainer');
  container.classList.add('pomo-complete-flash');
  setTimeout(() => container.classList.remove('pomo-complete-flash'), 1000);
}

function logSession(): void {
  if (!currentTask && distractionCount === 0) return;
  state.addPomoSession({
    task: currentTask || 'Untitled focus',
    duration: state.pomo.settings.focus,
    distractions: distractionCount,
  });
  renderSessionLog();
}

function renderSessionLog(): void {
  const section = $id('pomoSessionLog');
  const list = $id('pomoSessionList');
  const sessions = state.pomoSessions;
  if (sessions.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  list.innerHTML = sessions.map(s => {
    const time = new Date(s.completed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const escaped = s.task.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="pomo-session-entry">
      <span class="pomo-session-task">${escaped}</span>
      <span class="pomo-session-meta">${s.duration}m${s.distractions > 0 ? ` · ${s.distractions} distraction${s.distractions !== 1 ? 's' : ''}` : ''} · ${time}</span>
    </div>`;
  }).join('');
}

// --- Timer logic ---

function startTicking(): void {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(tick, 1000);
}

function stopTicking(): void {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

function complete(): void {
  const { pomo } = state;
  stopTicking();
  clearTimerStorage();

  if (pomo.soundOn) playSound();

  // Send notification (works when app is backgrounded)
  const wasMode = pomo.mode;
  if (wasMode === 'focus') {
    sendNotification('Focus complete', currentTask
      ? `"${currentTask}" — time for a break.`
      : 'Great work — time for a break.');
  } else {
    sendNotification('Break over', 'Ready for another focus session?');
  }

  if (wasMode === 'focus') {
    pomo.completedPomos++;
    pomo.focusMinutes += pomo.settings.focus;
    pomo.streak++;
    state.savePomo();

    celebrate();
    logSession();

    // Reset for next focus
    distractionCount = 0;
    currentTask = '';
    ($id('pomoTaskInput') as HTMLInputElement).value = '';

    // Auto-switch to break
    if (pomo.completedPomos % pomo.settings.longAfter === 0) {
      setMode('long');
    } else {
      setMode('short');
    }

    // Auto-start break if enabled
    if (autoStartBreaks) {
      setTimeout(() => toggle(), 600);
    }
  } else {
    setMode('focus');
  }
  render();
}

function tick(): void {
  const { pomo } = state;
  if (pomo.secondsLeft <= 0) {
    pomo.running = false;
    complete();
    return;
  }
  pomo.secondsLeft--;
  render();
}

function setMode(mode: PomoMode): void {
  const { pomo } = state;
  stopTicking();
  pomo.running = false;
  pomo.mode = mode;
  syncSettingsFromInputs();
  pomo.totalSeconds = getDuration(mode) * 60;
  pomo.secondsLeft = pomo.totalSeconds;
  clearTimerStorage();
  render();
}

function toggle(): void {
  const { pomo } = state;
  if (pomo.running) {
    stopTicking();
    pomo.running = false;
  } else {
    // Sync settings from inputs before starting a fresh session
    if (pomo.secondsLeft === pomo.totalSeconds) {
      syncSettingsFromInputs();
      const dur = getDuration(pomo.mode) * 60;
      if (dur !== pomo.totalSeconds) {
        pomo.totalSeconds = dur;
        pomo.secondsLeft = dur;
      }
    }
    // Capture task on first start of a focus session
    if (pomo.mode === 'focus' && pomo.secondsLeft === pomo.totalSeconds) {
      currentTask = ($id('pomoTaskInput') as HTMLInputElement).value.trim();
    }
    // Request notification permission on first interaction
    requestNotificationPermission();
    pomo.running = true;
    startTicking();
  }
  saveTimer();
  render();
}

function reset(): void {
  const { pomo } = state;
  stopTicking();
  pomo.running = false;
  pomo.secondsLeft = pomo.totalSeconds;
  clearTimerStorage();
  render();
}

function skip(): void {
  stopTicking();
  state.pomo.running = false;
  complete();
}

function addDistraction(): void {
  distractionCount++;
  saveTimer();

  // Brief visual feedback
  const btn = $id('pomoDistractionBtn');
  btn.classList.add('pomo-distraction-flash');
  setTimeout(() => btn.classList.remove('pomo-distraction-flash'), 300);
  render();
}

function updateSettings(): void {
  const { settings } = state.pomo;
  settings.focus = parseInt(($id('pomoFocusDur') as HTMLInputElement).value) || 25;
  settings.short = parseInt(($id('pomoShortDur') as HTMLInputElement).value) || 5;
  settings.long = parseInt(($id('pomoLongDur') as HTMLInputElement).value) || 15;
  settings.longAfter = parseInt(($id('pomoLongAfter') as HTMLInputElement).value) || 4;
  state.savePomo();

  if (!state.pomo.running) {
    state.pomo.totalSeconds = getDuration(state.pomo.mode) * 60;
    state.pomo.secondsLeft = state.pomo.totalSeconds;
    render();
  }
}

function toggleSound(): void {
  state.pomo.soundOn = !state.pomo.soundOn;
  const btn = $id('pomoSoundBtn');
  btn.textContent = state.pomo.soundOn ? 'On' : 'Off';
  btn.classList.toggle('on', state.pomo.soundOn);
  state.savePomo();
}

function toggleAutoBreak(): void {
  autoStartBreaks = !autoStartBreaks;
  const btn = $id('pomoAutoBreakBtn');
  btn.textContent = autoStartBreaks ? 'On' : 'Off';
  btn.classList.toggle('on', autoStartBreaks);
}

// --- Visibility change: recalculate on return ---

function onVisibilityChange(): void {
  if (document.hidden) return;

  // App came back to foreground — recalculate from stored timestamp
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const snap: TimerSnapshot = JSON.parse(raw);
    if (snap.pausedRemaining !== null) return; // was paused, nothing to recalc

    const elapsed = Math.floor((Date.now() - snap.startedAt) / 1000);
    const remaining = snap.totalSeconds - elapsed;

    if (remaining <= 0) {
      // Completed while backgrounded
      state.pomo.secondsLeft = 0;
      state.pomo.running = false;
      stopTicking();
      complete();
    } else {
      state.pomo.secondsLeft = remaining;
      render();
    }
  } catch { /* ignore */ }
}

export function initPomodoro(): void {
  // Load saved settings into UI
  const { settings, soundOn } = state.pomo;
  ($id('pomoFocusDur') as HTMLInputElement).value = String(settings.focus);
  ($id('pomoShortDur') as HTMLInputElement).value = String(settings.short);
  ($id('pomoLongDur') as HTMLInputElement).value = String(settings.long);
  ($id('pomoLongAfter') as HTMLInputElement).value = String(settings.longAfter);

  const soundBtn = $id('pomoSoundBtn');
  soundBtn.textContent = soundOn ? 'On' : 'Off';
  soundBtn.classList.toggle('on', soundOn);

  // Sync totalSeconds from settings (default pomo state has hardcoded 25*60)
  if (!state.pomo.running) {
    state.pomo.totalSeconds = getDuration(state.pomo.mode) * 60;
    state.pomo.secondsLeft = state.pomo.totalSeconds;
  }

  // Restore timer if one was active (overrides the above if a session was in progress)
  restoreTimer();

  // Wire events
  document.querySelectorAll<HTMLElement>('.pomo-mode-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => setMode(POMO_MODES[i]));
  });

  $id('pomoPlayBtn').addEventListener('click', toggle);
  $id('pomoResetBtn').addEventListener('click', reset);
  $id('pomoSkipBtn').addEventListener('click', skip);
  $id('pomoSoundBtn').addEventListener('click', toggleSound);
  $id('pomoAutoBreakBtn').addEventListener('click', toggleAutoBreak);
  $id('pomoDistractionBtn').addEventListener('click', addDistraction);

  // Start on Enter from task input
  $id('pomoTaskInput').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter' && !state.pomo.running) {
      toggle();
    }
  });

  document.querySelectorAll('#pomoFocusDur, #pomoShortDur, #pomoLongDur, #pomoLongAfter')
    .forEach(input => {
      input.addEventListener('change', updateSettings);
      input.addEventListener('input', updateSettings);
    });

  // Recalculate timer when app returns from background
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Render sessions loaded from DB (all devices)
  renderSessionLog();

  render();
}
