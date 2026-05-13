import { supabase } from './supabase.js';
import { isNative } from './native.js';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

/** Subscribe this device to receive notifications.
 *
 *  On native (Capacitor) this is a no-op — the app schedules its own
 *  OS-level LocalNotifications for reminders, blocks, pomodoro completion,
 *  and the daily/weekly summaries. The server-side Edge Function only
 *  serves Web Push to PWA/browser clients.
 */
export async function subscribeToPush(userId: string): Promise<void> {
  if (isNative) return;
  await subscribeToPushWeb(userId);
}

/** Request notification permission. On native, LocalNotifications.requestPermissions()
 *  is called inside each scheduler when an alarm is first armed — so this
 *  flow only matters on web. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (isNative) {
    // Defer to the LocalNotifications permission flow which fires inside
    // every scheduler. Treat the click here as a no-op consent gesture.
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const status = await LocalNotifications.checkPermissions();
    if (status.display === 'granted') return true;
    const req = await LocalNotifications.requestPermissions();
    return req.display === 'granted';
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

/** Tear down this device's web push registration. On native this is a no-op
 *  — local notifications are device-local and the OS handles them. Reminder
 *  alarms are cancelled by the auth-signout flow via the existing
 *  cancelReminderNative path, not here. */
export async function unsubscribeFromPush(userId: string): Promise<void> {
  if (isNative) return;
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
