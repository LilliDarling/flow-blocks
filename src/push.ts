import { supabase } from './supabase.js';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export async function subscribeToPush(userId: string): Promise<void> {
  try {
    if (!VAPID_PUBLIC_KEY) { console.warn('[push] no VAPID key'); return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { console.warn('[push] no SW/PushManager'); return; }
    if (Notification.permission !== 'granted') { console.warn('[push] permission:', Notification.permission); return; }

    const reg = await navigator.serviceWorker.ready;

    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: VAPID_PUBLIC_KEY,
      });
    }

    const p256dh = subscription.getKey('p256dh');
    const auth = subscription.getKey('auth');
    if (!p256dh || !auth) { console.warn('[push] missing keys'); return; }

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: arrayBufferToBase64Url(p256dh),
        auth: arrayBufferToBase64Url(auth),
        timezone,
      }, { onConflict: 'user_id,endpoint' });

    if (error) console.error('[push] upsert failed:', error.message);
    else console.log('[push] subscription saved');
  } catch (err) {
    console.error('[push] error:', err);
  }
}

/** Request notification permission (must be called from a user gesture). */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}


function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
