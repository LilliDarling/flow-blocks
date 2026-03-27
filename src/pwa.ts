import { $id } from './utils.js';

/** Captured `beforeinstallprompt` event — available until the user installs or dismisses. */
let deferredPrompt: Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> } | null = null;

// --- Install banner ---

function showInstallBanner(): void {
  $id('installBanner').style.display = 'flex';
}

function hideInstallBanner(): void {
  $id('installBanner').style.display = 'none';
}

async function handleInstallClick(): Promise<void> {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  hideInstallBanner();

  if (outcome === 'accepted') {
    console.log('PWA installed');
  }
}

// --- Update handling ---

let updateReady = false;
let applyingUpdate = false;

function showUpdateToast(): void {
  $id('updateToast').style.display = 'flex';
}

function applyUpdate(): void {
  if (applyingUpdate) return;
  applyingUpdate = true;

  // Listen for controller change before sending skip-waiting
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });

  navigator.serviceWorker.getRegistration().then((reg) => {
    if (reg?.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      // Waiting worker already activated or was evicted — just reload
      window.location.reload();
    }
  });
}

function handleUpdateClick(): void {
  if (applyingUpdate) {
    // Previous attempt didn't reload — force it
    window.location.reload();
    return;
  }
  applyUpdate();
}

// --- Service worker registration with update detection ---

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // Check for updates every 30 minutes
    setInterval(() => reg.update(), 30 * 60 * 1000);

    // If there's already a waiting worker (e.g. update happened while tab was open)
    if (reg.waiting) {
      markUpdateReady();
      return;
    }

    // Listen for new service worker installing
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;

      newWorker.addEventListener('statechange', () => {
        // New SW installed and waiting
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          markUpdateReady();
        }
      });
    });
  }).catch(() => {
    // SW blocked (dev mode, incognito, or browser policy) — app works fine without it
  });
}

/** Flag an update as ready — auto-applies on next focus, or immediately if already focused. */
function markUpdateReady(): void {
  updateReady = true;
  if (document.visibilityState === 'visible') {
    applyUpdate();
  }
  // Fallback: show toast in case auto-reload takes a moment
  showUpdateToast();
}

// --- Init ---

export function initPWA(): void {
  // Capture the install prompt before the browser shows it
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as typeof deferredPrompt;
    showInstallBanner();
  });

  // Hide banner if already installed (standalone mode)
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstallBanner();
  });

  // Wire up install button + dismiss
  $id('installBtn').addEventListener('click', handleInstallClick);
  $id('installDismiss').addEventListener('click', () => {
    hideInstallBanner();
    // Don't show again this session
    sessionStorage.setItem('pwa_install_dismissed', '1');
  });

  // Wire up update toast
  $id('updateBtn').addEventListener('click', handleUpdateClick);
  $id('updateDismiss').addEventListener('click', () => {
    $id('updateToast').style.display = 'none';
  });

  // Don't show install banner if dismissed this session
  if (sessionStorage.getItem('pwa_install_dismissed')) {
    hideInstallBanner();
  }

  // Auto-apply pending updates when tab regains focus
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    // If an update is already waiting, apply it now
    if (updateReady) {
      applyUpdate();
      return;
    }

    // Otherwise, check for new updates on each focus
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) reg.update();
    });
  });

  // Register SW with update detection
  registerServiceWorker();
}
