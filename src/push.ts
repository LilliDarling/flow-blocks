import { supabase } from './supabase.js';
import { isNative, nativePlatform } from './native.js';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export async function subscribeToPush(userId: string): Promise<void> {
  if (isNative) {
    await subscribeToPushNative(userId);
    return;
  }
  await subscribeToPushWeb(userId);
}

/** Request notification permission (must be called from a user gesture on web). */
export async function requestNotificationPermission(): Promise<boolean> {
  if (isNative) {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const status = await PushNotifications.requestPermissions();
    return status.receive === 'granted';
  }
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

// --- Web Push (PWA) ---

async function subscribeToPushWeb(userId: string): Promise<void> {
  try {
    if (!VAPID_PUBLIC_KEY) { console.warn('[push] no VAPID key'); return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { console.warn('[push] no SW/PushManager'); return; }
    if (Notification.permission !== 'granted') { console.warn('[push] permission:', Notification.permission); return; }

    const reg = await navigator.serviceWorker.ready;

    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
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

/** Tear down this device's push registration and remove its server row, so a
 * different user signing in later doesn't keep receiving the previous user's
 * reminders. Must run before supabase.auth.signOut() — once the session is
 * gone, the DELETE will be rejected by RLS. */
export async function unsubscribeFromPush(userId: string): Promise<void> {
  if (isNative) {
    await unsubscribeFromPushNative(userId);
    return;
  }
  await unsubscribeFromPushWeb(userId);
}

async function unsubscribeFromPushWeb(userId: string): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return;

    await supabase
      .from('push_subscriptions')
      .delete()
      .eq('user_id', userId)
      .eq('endpoint', subscription.endpoint);

    await subscription.unsubscribe();
  } catch (err) {
    console.warn('[push] web unsubscribe failed:', err);
  }
}

async function unsubscribeFromPushNative(userId: string): Promise<void> {
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    // Re-resolve the current device token so we can delete the exact row that
    // subscribeToPushNative wrote. register() is idempotent — the OS hands
    // back the same token. 5s ceiling so a slow registration can't stall
    // sign-out indefinitely.
    //
    // Track listener handles so we can remove them after — Capacitor's
    // addListener accumulates native-side and isn't cleared by WebView
    // reload, so without this each subscribe/unsubscribe cycle leaks two.
    const listenerHandles: Array<Promise<{ remove: () => Promise<void> }>> = [];
    let token: string | null;
    try {
      token = await new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (value: string | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        listenerHandles.push(PushNotifications.addListener('registration', (t) => finish(t.value)));
        listenerHandles.push(PushNotifications.addListener('registrationError', () => finish(null)));
        PushNotifications.register();
        setTimeout(() => finish(null), 5000);
      });
    } finally {
      const resolved = await Promise.all(listenerHandles);
      await Promise.all(resolved.map(h => h.remove().catch(() => { /* ignore */ })));
    }

    if (!token) return;

    await supabase
      .from('device_push_tokens')
      .delete()
      .eq('user_id', userId)
      .eq('token', token);
  } catch (err) {
    console.warn('[push] native unsubscribe failed:', err);
  }
}

// --- Native Push (FCM / APNs via Capacitor) ---

async function subscribeToPushNative(userId: string): Promise<void> {
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    const status = await PushNotifications.checkPermissions();
    let granted = status.receive === 'granted';
    if (!granted) {
      const requested = await PushNotifications.requestPermissions();
      granted = requested.receive === 'granted';
    }
    if (!granted) { console.warn('[push] native permission denied'); return; }

    // Resolve the device token — APNs on iOS, FCM on Android.
    // Listener handles are tracked so we can remove them after — addListener
    // accumulates native-side across calls and isn't cleared by WebView
    // reload, so without this every sign-in/out cycle leaks two listeners.
    const listenerHandles: Array<Promise<{ remove: () => Promise<void> }>> = [];
    let token: string | null;
    try {
      token = await new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (value: string | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        listenerHandles.push(PushNotifications.addListener('registration', (t) => finish(t.value)));
        listenerHandles.push(PushNotifications.addListener('registrationError', (err) => {
          console.warn('[push] native registration error:', err);
          finish(null);
        }));
        PushNotifications.register();
        setTimeout(() => finish(null), 10000);
      });
    } finally {
      const resolved = await Promise.all(listenerHandles);
      await Promise.all(resolved.map(h => h.remove().catch(() => { /* ignore */ })));
    }

    if (!token) return;

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const { error } = await supabase
      .from('device_push_tokens')
      .upsert({
        user_id: userId,
        token,
        platform: nativePlatform, // 'ios' | 'android'
        timezone,
      }, { onConflict: 'user_id,token' });

    if (error) console.error('[push] native upsert failed:', error.message);
    else console.log('[push] native token saved');
  } catch (err) {
    console.error('[push] native error:', err);
  }
}

// --- Web Push helpers ---

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
