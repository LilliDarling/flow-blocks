import { Capacitor } from '@capacitor/core';
import { supabase } from './supabase.js';

export const isNative: boolean = Capacitor.isNativePlatform();
export const nativePlatform: string = Capacitor.getPlatform(); // 'ios' | 'android' | 'web'

/**
 * Initialise native-only listeners and chrome.
 *
 * Called from app.ts during boot, before auth/render. Safe no-op on web.
 */
export async function initNative(): Promise<void> {
  if (!isNative) return;

  await Promise.all([
    setupStatusBar(),
    setupDeepLinks(),
    hideNativeSplash(),
  ]);
}

/** Match status bar to app theme so it doesn't flash white over our dark UI. */
async function setupStatusBar(): Promise<void> {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const isLight = document.documentElement.classList.contains('light');
    await StatusBar.setStyle({ style: isLight ? Style.Light : Style.Dark });
    if (nativePlatform === 'android') {
      await StatusBar.setBackgroundColor({ color: isLight ? '#ffffff' : '#1a1f17' });
    }
  } catch {
    /* status bar plugin missing — ignore */
  }
}

/** Listen for `wildbloom://auth/...` redirects from external OAuth flows. */
async function setupDeepLinks(): Promise<void> {
  const { App } = await import('@capacitor/app');
  App.addListener('appUrlOpen', async (event) => {
    const url = event.url;
    if (!url.includes('auth')) return;

    // Supabase returns tokens in the URL fragment after OAuth.
    const hash = url.split('#')[1];
    if (!hash) return;

    const params = new URLSearchParams(hash);
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    if (!access_token || !refresh_token) return;

    await supabase.auth.setSession({ access_token, refresh_token });

    // Close the in-app browser if it's still up.
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.close();
    } catch {
      /* browser may already be closed */
    }
  });
}

/** Capacitor shows its own splash; fade it out once our app boots. */
async function hideNativeSplash(): Promise<void> {
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 300 });
  } catch {
    /* splash plugin missing — ignore */
  }
}
