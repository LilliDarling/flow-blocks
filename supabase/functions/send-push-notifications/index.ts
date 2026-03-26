// Supabase Edge Function: Send Web Push notifications for due reminders
// and energy check-ins. Called every minute by pg_cron via pg_net.
//
// Uses Web Crypto API directly (no npm web-push) for Deno compatibility.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:noreply@wildbloom.app';
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;

// ── Base64url helpers ───────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  const pad = '='.repeat((4 - str.length % 4) % 4);
  const bin = atob((str + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// ── VAPID JWT (ES256) ───────────────────────────────────────────────

async function createVapidJwt(audience: string): Promise<string> {
  const pubBytes = b64urlDecode(VAPID_PUBLIC_KEY);
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64url(pubBytes.slice(1, 33)),
    y: b64url(pubBytes.slice(33, 65)),
    d: VAPID_PRIVATE_KEY,
  };
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );

  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    aud: audience, exp: now + 12 * 3600, sub: VAPID_SUBJECT,
  })));

  const unsigned = `${header}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned),
  ));
  return `${unsigned}.${b64url(sig)}`;
}

// ── Web Push Encryption (RFC 8291 / aes128gcm) ─────────────────────

async function hkdf(
  salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8,
  ));
}

async function encryptPayload(
  plaintext: string, p256dhB64: string, authB64: string,
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);

  // Ephemeral ECDH key pair
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  // ECDH shared secret
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, ephemeral.privateKey, 256,
  ));

  // IKM = HKDF(auth_secret, shared, "WebPush: info\0" || ua_public || eph_public, 32)
  const infoPrefix = new TextEncoder().encode('WebPush: info\0');
  const ikmInfo = new Uint8Array(infoPrefix.length + uaPublic.length + ephPub.length);
  ikmInfo.set(infoPrefix);
  ikmInfo.set(uaPublic, infoPrefix.length);
  ikmInfo.set(ephPub, infoPrefix.length + uaPublic.length);
  const ikm = await hkdf(authSecret, shared, ikmInfo, 32);

  // Random salt for this message
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Derive content encryption key and nonce
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  // Pad plaintext (add \x02 delimiter for last record)
  const ptBytes = new TextEncoder().encode(plaintext);
  const padded = new Uint8Array(ptBytes.length + 1);
  padded.set(ptBytes);
  padded[ptBytes.length] = 2;

  // AES-128-GCM encrypt
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  // Build aes128gcm record: salt(16) + rs(4) + idlen(1) + keyid(65) + ciphertext
  const headerLen = 16 + 4 + 1 + 65;
  const record = new Uint8Array(headerLen + ct.length);
  record.set(salt, 0);
  new DataView(record.buffer).setUint32(16, 4096);
  record[20] = 65;
  record.set(ephPub, 21);
  record.set(ct, headerLen);
  return record;
}

// ── Send a single push notification ─────────────────────────────────

async function sendPush(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
): Promise<number> {
  const audience = new URL(sub.endpoint).origin;
  const jwt = await createVapidJwt(audience);
  const body = await encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);

  const resp = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
    },
    body,
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    console.error(`[push] FCM ${resp.status}: ${errBody} endpoint=${sub.endpoint.slice(-20)}`);
  }
  return resp.status;
}

// ── Main handler ────────────────────────────────────────────────────

serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // 1. Get all push subscriptions
  const { data: subs, error: subsErr } = await supabase
    .from('push_subscriptions')
    .select('*');

  if (subsErr || !subs || subs.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Get all reminders for users who have push subscriptions
  const userIds = [...new Set(subs.map((s: { user_id: string }) => s.user_id))];

  const { data: reminders } = await supabase
    .from('reminders')
    .select('*')
    .in('user_id', userIds);

  const now = new Date();
  let sent = 0;

  // Group subscriptions by user
  const subsByUser = new Map<string, typeof subs>();
  for (const sub of subs) {
    const list = subsByUser.get(sub.user_id) || [];
    list.push(sub);
    subsByUser.set(sub.user_id, list);
  }

  // Helper: send to ALL of a user's subscriptions
  async function sendToAll(
    userSubs: typeof subs,
    payload: string,
  ): Promise<number> {
    let count = 0;
    for (const sub of userSubs) {
      try {
        const status = await sendPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        if (status >= 200 && status < 300) count++;
        if (status === 410 || status === 404) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        }
      } catch {
        // network error — skip
      }
    }
    return count;
  }

  // --- Reminder notifications ---

  if (reminders && reminders.length > 0) {
    for (const [userId, userSubs] of subsByUser) {
      const tz = userSubs[0].timezone || 'UTC';
      const localDate = now.toLocaleDateString('en-CA', { timeZone: tz });
      const localDow = localDayOfWeek(now, tz);
      const nowMinutes = localMinutesSinceMidnight(now, tz);

      const userReminders = reminders.filter(
        (r: { user_id: string }) => r.user_id === userId,
      );

      for (const reminder of userReminders) {
        if (!reminder.days.includes(localDow)) continue;

        const [rh, rm] = reminder.reminder_time.slice(0, 5).split(':').map(Number);
        const reminderMinutes = rh * 60 + rm;

        const diff = reminderMinutes - nowMinutes;
        if (diff < -5 || diff > 5) continue;

        const { count: compCount } = await supabase
          .from('reminder_completions')
          .select('*', { count: 'exact', head: true })
          .eq('reminder_id', reminder.id)
          .eq('completion_date', localDate);

        if (compCount && compCount > 0) continue;

        const { count: skipCount } = await supabase
          .from('reminder_skips')
          .select('*', { count: 'exact', head: true })
          .eq('reminder_id', reminder.id)
          .eq('skip_date', localDate);

        if (skipCount && skipCount > 0) continue;

        // Dedup: one notification per reminder per day
        const { error: dedupErr } = await supabase
          .from('push_notification_log')
          .insert({
            reminder_id: reminder.id,
            notification_date: localDate,
          });

        if (dedupErr) continue;

        const payload = JSON.stringify({
          title: `${reminder.icon || '💊'} ${reminder.name}`,
          body: `Gentle reminder — it's ${formatTime(reminder.reminder_time.slice(0, 5))}`,
          icon: '/icons/icon.png',
          tag: `reminder-${reminder.id}`,
          url: '/',
        });

        // Send to ALL of this user's devices
        sent += await sendToAll(userSubs, payload);
      }
    }
  }

  // --- Energy check-in notifications ---
  // Every 2 hours between 9AM-9PM in the user's timezone.
  // Slots: 9, 11, 13, 15, 17, 19

  const ENERGY_SLOTS = [9, 11, 13, 15, 17, 19];

  for (const [userId, userSubs] of subsByUser) {
    const tz = userSubs[0].timezone || 'UTC';
    const localDate = now.toLocaleDateString('en-CA', { timeZone: tz });
    const nowMinutes = localMinutesSinceMidnight(now, tz);

    const dueSlot = ENERGY_SLOTS.find((slotHour) => {
      const slotMinutes = slotHour * 60;
      const diff = slotMinutes - nowMinutes;
      return diff >= -5 && diff <= 5;
    });

    if (dueSlot === undefined) continue;

    // Dedup: one notification per user per slot per day
    const { error: dedupErr } = await supabase
      .from('energy_checkin_notification_log')
      .insert({
        user_id: userId,
        checkin_date: localDate,
        slot_hour: dueSlot,
      });

    if (dedupErr) continue;

    // Skip if user already logged energy in the last 90 minutes
    const cutoff = new Date(now.getTime() - 90 * 60 * 1000).toISOString();
    const { count: recentLogs } = await supabase
      .from('energy_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('logged_at', cutoff);

    if (recentLogs && recentLogs > 0) continue;

    const payload = JSON.stringify({
      title: '\u26A1 Energy Check-in',
      body: 'Quick check \u2014 how is your energy right now?',
      icon: '/icons/icon.png',
      tag: 'energy-checkin',
      url: '/?action=energy-checkin',
      type: 'energy-checkin',
    });

    // Send to ALL of this user's devices
    sent += await sendToAll(userSubs, payload);
  }

  return new Response(JSON.stringify({ sent }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

/** Get minutes since midnight in the given timezone */
function localMinutesSinceMidnight(date: Date, timezone: string): number {
  const timeStr = date.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/** Convert local day-of-week to project convention: Mon=0 .. Sun=6 */
function localDayOfWeek(date: Date, timezone: string): number {
  const dayStr = date.toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });
  const map: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  };
  return map[dayStr] ?? 0;
}

/** Format "HH:MM" to "h:MM AM/PM" */
function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
