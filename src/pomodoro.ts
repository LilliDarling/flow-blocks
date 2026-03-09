import { state } from './state.js';
import { PomoMode, $id } from './utils.js';

const RING_CIRCUMFERENCE = 2 * Math.PI * 124;
const POMO_MODES: PomoMode[] = ['focus', 'short', 'long'];

function getColor(): string {
  if (state.pomo.mode === 'focus') return 'var(--deep)';
  if (state.pomo.mode === 'short') return 'var(--recharge)';
  return 'var(--flex)';
}

function getLabel(): string {
  if (state.pomo.mode === 'focus') return 'Focus time';
  if (state.pomo.mode === 'short') return 'Short break';
  return 'Long break';
}

function getDuration(mode: PomoMode): number {
  return state.pomo.settings[mode === 'long' ? 'long' : mode === 'short' ? 'short' : 'focus'];
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

function complete(): void {
  const { pomo } = state;

  if (pomo.soundOn) playSound();

  if (pomo.mode === 'focus') {
    pomo.completedPomos++;
    pomo.focusMinutes += pomo.settings.focus;
    pomo.streak++;
    state.savePomo();

    // Auto-switch to break
    if (pomo.completedPomos % pomo.settings.longAfter === 0) {
      setMode('long');
    } else {
      setMode('short');
    }
  } else {
    setMode('focus');
  }
  render();
}

function tick(): void {
  if (state.pomo.secondsLeft <= 0) {
    clearInterval(state.pomo.interval!);
    state.pomo.running = false;
    complete();
    return;
  }
  state.pomo.secondsLeft--;
  render();
}

function setMode(mode: PomoMode): void {
  const { pomo } = state;
  if (pomo.running && pomo.interval) {
    clearInterval(pomo.interval);
    pomo.running = false;
  }
  pomo.mode = mode;
  pomo.totalSeconds = getDuration(mode) * 60;
  pomo.secondsLeft = pomo.totalSeconds;
  render();
}

function toggle(): void {
  const { pomo } = state;
  if (pomo.running) {
    clearInterval(pomo.interval!);
    pomo.running = false;
  } else {
    pomo.running = true;
    pomo.interval = setInterval(tick, 1000);
  }
  render();
}

function reset(): void {
  const { pomo } = state;
  if (pomo.running && pomo.interval) {
    clearInterval(pomo.interval);
    pomo.running = false;
  }
  pomo.secondsLeft = pomo.totalSeconds;
  render();
}

function skip(): void {
  const { pomo } = state;
  if (pomo.running && pomo.interval) {
    clearInterval(pomo.interval);
    pomo.running = false;
  }
  complete();
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

  // Wire events
  document.querySelectorAll<HTMLElement>('.pomo-mode-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => setMode(POMO_MODES[i]));
  });

  $id('pomoPlayBtn').addEventListener('click', toggle);
  $id('pomoResetBtn').addEventListener('click', reset);
  $id('pomoSkipBtn').addEventListener('click', skip);
  $id('pomoSoundBtn').addEventListener('click', toggleSound);

  document.querySelectorAll('#pomoFocusDur, #pomoShortDur, #pomoLongDur, #pomoLongAfter')
    .forEach(input => input.addEventListener('change', updateSettings));

  render();
}
