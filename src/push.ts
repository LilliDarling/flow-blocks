import { supabase } from './supabase.js';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export async function subscribeToPush(userId: string): Promise<void> {
  if (!VAPID_PUBLIC_KEY) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission === 'denied') return;

  // Request permission if not yet granted
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return;
  }

  const reg = await navigator.serviceWorker.ready;

  // Reuse existing subscription or create a new one
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const p256dh = subscription.getKey('p256dh');
  const auth = subscription.getKey('auth');
  if (!p256dh || !auth) return;

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  await supabase
    .from('push_subscriptions')
    .upsert({
      user_id: userId,
      endpoint: subscription.endpoint,
      p256dh: arrayBufferToBase64Url(p256dh),
      auth: arrayBufferToBase64Url(auth),
      timezone,
    }, { onConflict: 'user_id,endpoint' });
}

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
