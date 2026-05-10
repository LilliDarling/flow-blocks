// Supabase Edge Function: Send Web Push notifications for reminders,
// pomodoro timers, block nudges, daily review, and weekly recap.
// Called every minute by pg_cron via pg_net.
//
// Uses Web Crypto API directly (no npm web-push) for Deno compatibility.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:noreply@wildbloom.app';
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;

// FCM HTTP v1 — credentials for native push dispatch (Android/iOS via Capacitor).
// Both must be set for native delivery; if absent, native dispatch is skipped
// and the function still serves Web Push subscribers.
const FCM_PROJECT_ID = Deno.env.get('FCM_PROJECT_ID') || '';
const FCM_SERVICE_ACCOUNT_KEY = Deno.env.get('FCM_SERVICE_ACCOUNT_KEY') || '';

// deno-lint-ignore no-explicit-any
type Sub = any;
// deno-lint-ignore no-explicit-any
type DeviceToken = any;
// deno-lint-ignore no-explicit-any
type BlockRow = any;
// deno-lint-ignore no-explicit-any
type ReminderRow = any;

interface SendOpts {
  /** Skip native (FCM) delivery. Used by reminders, where native devices fire
   *  OS-scheduled LocalNotifications client-side and would otherwise double-fire. */
  webOnly?: boolean;
}

interface Ctx {
  supabase: SupabaseClient;
  userIds: Set<string>;
  reminders: ReminderRow[];
  blocks: BlockRow[];
  now: Date;
  getTimezone: (userId: string) => string;
  sendToAll: (userId: string, payload: string, opts?: SendOpts) => Promise<number>;
}

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

  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, ephemeral.privateKey, 256,
  ));

  const infoPrefix = new TextEncoder().encode('WebPush: info\0');
  const ikmInfo = new Uint8Array(infoPrefix.length + uaPublic.length + ephPub.length);
  ikmInfo.set(infoPrefix);
  ikmInfo.set(uaPublic, infoPrefix.length);
  ikmInfo.set(ephPub, infoPrefix.length + uaPublic.length);
  const ikm = await hkdf(authSecret, shared, ikmInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const ptBytes = new TextEncoder().encode(plaintext);
  const padded = new Uint8Array(ptBytes.length + 1);
  padded.set(ptBytes);
  padded[ptBytes.length] = 2;

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

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

// ── FCM HTTP v1 (native push) ──────────────────────────────────────

interface FcmServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

let cachedFcmAccount: FcmServiceAccount | null | undefined = undefined;

function getFcmAccount(): FcmServiceAccount | null {
  if (cachedFcmAccount !== undefined) return cachedFcmAccount;
  if (!FCM_SERVICE_ACCOUNT_KEY) {
    cachedFcmAccount = null;
    return null;
  }
  try {
    const parsed = JSON.parse(FCM_SERVICE_ACCOUNT_KEY) as FcmServiceAccount;
    if (!parsed.client_email || !parsed.private_key || !parsed.token_uri) {
      console.error('[fcm] service account JSON missing required fields');
      cachedFcmAccount = null;
      return null;
    }
    cachedFcmAccount = parsed;
    return parsed;
  } catch (err) {
    console.error('[fcm] failed to parse FCM_SERVICE_ACCOUNT_KEY:', err);
    cachedFcmAccount = null;
    return null;
  }
}

async function importPkcs8PrivateKey(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
}

/** Mint a fresh OAuth access token for FCM. Token is valid 1h; one mint per
 * function invocation amortizes across all sends. */
async function mintFcmAccessToken(): Promise<string | null> {
  const account = getFcmAccount();
  if (!account) return null;
  if (!FCM_PROJECT_ID) {
    console.error('[fcm] FCM_PROJECT_ID is not set');
    return null;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claims = b64url(new TextEncoder().encode(JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: account.token_uri,
      iat: now,
      exp: now + 3600,
    })));
    const unsigned = `${header}.${claims}`;

    const key = await importPkcs8PrivateKey(account.private_key);
    const sig = new Uint8Array(await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned),
    ));
    const jwt = `${unsigned}.${b64url(sig)}`;

    const resp = await fetch(account.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.error(`[fcm] token exchange failed ${resp.status}: ${errBody}`);
      return null;
    }
    const json = await resp.json() as { access_token?: string };
    return json.access_token || null;
  } catch (err) {
    console.error('[fcm] mintFcmAccessToken error:', err);
    return null;
  }
}

interface FcmResult {
  status: number;
  shouldDelete: boolean;
}

/** Send one notification via FCM HTTP v1. The web payload (a JSON string) is
 * mapped: title/body → notification, everything else → data (FCM data values
 * must all be strings). Returns shouldDelete=true on signals that the token
 * is permanently invalid (uninstalled, replaced) so the caller can prune. */
async function sendFCM(
  token: string, platform: string, payloadJson: string, accessToken: string,
): Promise<FcmResult> {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(payloadJson);
  } catch {
    p = {};
  }

  const data: Record<string, string> = {};
  if (p.url) data.url = String(p.url);
  if (p.tag) data.tag = String(p.tag);
  if (p.type) data.type = String(p.type);
  if (p.blockId) data.blockId = String(p.blockId);

  const message: Record<string, unknown> = {
    token,
    notification: {
      title: typeof p.title === 'string' ? p.title : '',
      body: typeof p.body === 'string' ? p.body : '',
    },
    data,
  };

  if (platform === 'android') {
    message.android = { priority: 'high' };
  } else if (platform === 'ios') {
    message.apns = {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: 'default' } },
    };
  }

  const resp = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    },
  );

  if (resp.ok) return { status: resp.status, shouldDelete: false };

  const errBody = await resp.text().catch(() => '');
  console.error(`[fcm] ${resp.status}: ${errBody.slice(0, 200)} platform=${platform} token=…${token.slice(-8)}`);

  // 404 = token not registered; 400 with UNREGISTERED/INVALID_ARGUMENT for the
  // token itself = device replaced/uninstalled. Other 400s are bad payloads
  // (bug on our side) — don't delete the token for those.
  let shouldDelete = false;
  if (resp.status === 404) shouldDelete = true;
  else if (resp.status === 400 && /UNREGISTERED|registration-token-not-registered/i.test(errBody)) {
    shouldDelete = true;
  }
  return { status: resp.status, shouldDelete };
}

// ── Shared helpers ──────────────────────────────────────────────────

function localMinutesSinceMidnight(date: Date, timezone: string): number {
  const timeStr = date.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function localDayOfWeek(date: Date, timezone: string): number {
  const dayStr = date.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'short' });
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return map[dayStr] ?? 0;
}

function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** Get blocks active for a user on a given local date/dow, excluding completed/skipped. */
function getActiveBlocks(
  blocks: BlockRow[], userId: string, localDate: string, localDow: number,
  completions: Map<string, string>,
): BlockRow[] {
  return blocks.filter((b: BlockRow) => {
    if (b.user_id !== userId) return false;
    if (!b.start_time) return false; // pool blocks have no time

    const isToday = b.block_date
      ? b.block_date === localDate
      : (b.days || []).includes(localDow);
    if (!isToday) return false;

    // Check not completed/skipped
    if (b.block_date) {
      if (b.status === 'done' || b.status === 'skipped') return false;
    } else {
      const key = `${b.id}_${localDate}`;
      const status = completions.get(key);
      if (status === 'done' || status === 'skipped') return false;
    }
    return true;
  });
}

/** Generic dedup via notification_log. Returns true if insert succeeded (not a duplicate). */
async function dedup(
  supabase: SupabaseClient, userId: string, notificationType: string, dedupKey: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('notification_log')
    .insert({ user_id: userId, notification_type: notificationType, dedup_key: dedupKey });
  return !error;
}

// ── Notification handlers ───────────────────────────────────────────

async function handleReminders(ctx: Ctx): Promise<number> {
  let sent = 0;
  if (!ctx.reminders || ctx.reminders.length === 0) return sent;

  for (const userId of ctx.userIds) {
    const tz = ctx.getTimezone(userId);
    const localDate = ctx.now.toLocaleDateString('en-CA', { timeZone: tz });
    const localDow = localDayOfWeek(ctx.now, tz);
    const nowMinutes = localMinutesSinceMidnight(ctx.now, tz);

    const userReminders = ctx.reminders.filter((r: ReminderRow) => r.user_id === userId);

    for (const reminder of userReminders) {
      if (!reminder.days.includes(localDow)) continue;

      const [rh, rm] = reminder.reminder_time.slice(0, 5).split(':').map(Number);
      const diff = (rh * 60 + rm) - nowMinutes;
      if (diff < -5 || diff > 5) continue;

      const { count: compCount } = await ctx.supabase
        .from('reminder_completions')
        .select('*', { count: 'exact', head: true })
        .eq('reminder_id', reminder.id)
        .eq('completion_date', localDate);
      if (compCount && compCount > 0) continue;

      const { count: skipCount } = await ctx.supabase
        .from('reminder_skips')
        .select('*', { count: 'exact', head: true })
        .eq('reminder_id', reminder.id)
        .eq('skip_date', localDate);
      if (skipCount && skipCount > 0) continue;

      const { error: dedupErr } = await ctx.supabase
        .from('push_notification_log')
        .insert({ reminder_id: reminder.id, notification_date: localDate });
      if (dedupErr) continue;

      const payload = JSON.stringify({
        title: `${reminder.icon || '💊'} ${reminder.name}`,
        body: `Gentle reminder — it's ${formatTime(reminder.reminder_time.slice(0, 5))}`,
        icon: '/icons/icon.png',
        tag: `reminder-${reminder.id}`,
        url: '/',
      });
      // webOnly: native clients fire their own OS-scheduled LocalNotifications
      // for reminders. Server FCM would double-fire on the device.
      sent += await ctx.sendToAll(userId, payload, { webOnly: true });
    }
  }
  return sent;
}

async function handlePomoTimers(ctx: Ctx): Promise<number> {
  let sent = 0;
  const { data: duePomo } = await ctx.supabase
    .from('pomo_active_timers')
    .select('*')
    .lte('complete_at', ctx.now.toISOString());

  if (!duePomo || duePomo.length === 0) return sent;

  for (const timer of duePomo) {
    if (ctx.userIds.has(timer.user_id)) {
      const title = timer.mode === 'focus' ? 'Focus complete' : 'Break over';
      const body = timer.mode === 'focus'
        ? (timer.task ? `"${timer.task}" — time for a break.` : 'Great work — time for a break.')
        : 'Ready for another focus session?';

      const payload = JSON.stringify({
        title, body, icon: '/icons/icon.png',
        tag: 'pomo-complete', url: '/', type: 'pomo-complete',
      });
      sent += await ctx.sendToAll(timer.user_id, payload);
    }
    await ctx.supabase.from('pomo_active_timers').delete().eq('user_id', timer.user_id);
  }
  return sent;
}

async function handleDailyNudge(ctx: Ctx): Promise<number> {
  let sent = 0;
  const NUDGE_HOUR = 20;

  for (const userId of ctx.userIds) {
    const tz = ctx.getTimezone(userId);
    const localDate = ctx.now.toLocaleDateString('en-CA', { timeZone: tz });
    const nowMinutes = localMinutesSinceMidnight(ctx.now, tz);

    const diff = (NUDGE_HOUR * 60) - nowMinutes;
    if (diff < -5 || diff > 5) continue;

    const { error: dedupErr } = await ctx.supabase
      .from('daily_nudge_log')
      .insert({ user_id: userId, nudge_date: localDate });
    if (dedupErr) continue;

    const payload = JSON.stringify({
      title: "How'd today go?",
      body: 'Take a sec to check off what you got done.',
      icon: '/icons/icon.png',
      tag: 'daily-review', url: '/', type: 'daily-review',
    });
    sent += await ctx.sendToAll(userId, payload);
  }
  return sent;
}

async function handleBlockStartNudge(ctx: Ctx, completions: Map<string, string>): Promise<number> {
  let sent = 0;

  for (const userId of ctx.userIds) {
    const tz = ctx.getTimezone(userId);
    const localDate = ctx.now.toLocaleDateString('en-CA', { timeZone: tz });
    const localDow = localDayOfWeek(ctx.now, tz);
    const nowMinutes = localMinutesSinceMidnight(ctx.now, tz);

    const active = getActiveBlocks(ctx.blocks, userId, localDate, localDow, completions);

    for (const block of active) {
      const [bh, bm] = block.start_time.slice(0, 5).split(':').map(Number);
      const startMin = bh * 60 + bm;
      const diff = startMin - nowMinutes;

      // Fire when block starts in 4-5 minutes (cron runs every minute).
      // Narrow window: gives the user ~4 min to skip before the first tick
      // fires, while still leaving a 2-tick safety margin against cron lag.
      if (diff < 4 || diff > 5) continue;

      if (!await dedup(ctx.supabase, userId, 'block_start', `${block.id}:${localDate}`)) continue;

      const label = block.title || block.type;
      const payload = JSON.stringify({
        title: `Starting soon: ${label}`,
        body: `Your ${block.type} block begins at ${formatTime(block.start_time.slice(0, 5))}`,
        icon: '/icons/icon.png',
        tag: `block-start-${block.id}`,
        url: '/', type: 'block-start',
      });
      sent += await ctx.sendToAll(userId, payload);
    }
  }
  return sent;
}

async function handleBlockEndCheckin(ctx: Ctx, completions: Map<string, string>): Promise<number> {
  let sent = 0;

  for (const userId of ctx.userIds) {
    const tz = ctx.getTimezone(userId);
    const localDate = ctx.now.toLocaleDateString('en-CA', { timeZone: tz });
    const localDow = localDayOfWeek(ctx.now, tz);
    const nowMinutes = localMinutesSinceMidnight(ctx.now, tz);

    const active = getActiveBlocks(ctx.blocks, userId, localDate, localDow, completions);

    for (const block of active) {
      const [bh, bm] = block.start_time.slice(0, 5).split(':').map(Number);
      const endMin = bh * 60 + bm + block.duration;
      const diff = endMin - nowMinutes;

      // Fire within 2 minutes of block end
      if (diff < -2 || diff > 2) continue;

      if (!await dedup(ctx.supabase, userId, 'block_end', `${block.id}:${localDate}`)) continue;

      const label = block.title || block.type;
      const payload = JSON.stringify({
        title: `${label} just wrapped`,
        body: 'Did you finish?',
        icon: '/icons/icon.png',
        tag: `block-end-${block.id}`,
        url: '/', type: 'block-complete',
        blockId: block.id,
      });
      sent += await ctx.sendToAll(userId, payload);
    }
  }
  return sent;
}

async function handleMorningBrief(ctx: Ctx, completions: Map<string, string>): Promise<number> {
  let sent = 0;

  for (const userId of ctx.userIds) {
    const tz = ctx.getTimezone(userId);
    const localDate = ctx.now.toLocaleDateString('en-CA', { timeZone: tz });
    const localDow = localDayOfWeek(ctx.now, tz);
    const nowMinutes = localMinutesSinceMidnight(ctx.now, tz);

    // Only count blocks that are still active (not done/skipped) — otherwise
    // "First up" can announce a block the user has already opted out of.
    const active = getActiveBlocks(ctx.blocks, userId, localDate, localDow, completions);
    if (active.length === 0) continue;

    // Find the earliest block
    const sorted = [...active].sort((a: BlockRow, b: BlockRow) =>
      a.start_time.localeCompare(b.start_time)
    );
    const first = sorted[0];
    const [fh, fm] = first.start_time.slice(0, 5).split(':').map(Number);
    const firstMin = fh * 60 + fm;

    // Send 15 min before first block, no earlier than 7 AM
    const targetMin = Math.max(firstMin - 15, 7 * 60);
    const diff = targetMin - nowMinutes;
    if (diff < -2 || diff > 2) continue;

    if (!await dedup(ctx.supabase, userId, 'morning_brief', localDate)) continue;

    const firstLabel = first.title || first.type;
    const payload = JSON.stringify({
      title: `You've got ${active.length} thing${active.length > 1 ? 's' : ''} today`,
      body: `First up: ${firstLabel} at ${formatTime(first.start_time.slice(0, 5))}`,
      icon: '/icons/icon.png',
      tag: 'morning-brief',
      url: '/', type: 'daily-review',
    });
    sent += await ctx.sendToAll(userId, payload);
  }
  return sent;
}

async function handleMiddayPulse(ctx: Ctx, completions: Map<string, string>): Promise<number> {
  let sent = 0;
  const MIDDAY_HOUR = 13;

  for (const userId of ctx.userIds) {
    const tz = ctx.getTimezone(userId);
    const localDate = ctx.now.toLocaleDateString('en-CA', { timeZone: tz });
    const localDow = localDayOfWeek(ctx.now, tz);
    const nowMinutes = localMinutesSinceMidnight(ctx.now, tz);

    const diff = (MIDDAY_HOUR * 60) - nowMinutes;
    if (diff < -2 || diff > 2) continue;

    // Count today's blocks and how many are still pending
    const todayBlocks = ctx.blocks.filter((b: BlockRow) => {
      if (b.user_id !== userId || !b.start_time) return false;
      return b.block_date ? b.block_date === localDate : (b.days || []).includes(localDow);
    });
    if (todayBlocks.length === 0) continue;

    const pending = getActiveBlocks(ctx.blocks, userId, localDate, localDow, completions);
    if (pending.length === 0) continue;

    // Skip if user has been active recently (energy log in last 2 hours)
    const twoHoursAgo = new Date(ctx.now.getTime() - 2 * 60 * 60 * 1000);
    const { count: recentLogs } = await ctx.supabase
      .from('energy_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('logged_at', twoHoursAgo.toISOString());
    if (recentLogs && recentLogs > 0) continue;

    if (!await dedup(ctx.supabase, userId, 'midday_pulse', localDate)) continue;

    const payload = JSON.stringify({
      title: `${pending.length} of ${todayBlocks.length} blocks still pending`,
      body: "How's the day going?",
      icon: '/icons/icon.png',
      tag: 'midday-pulse',
      url: '/', type: 'daily-review',
    });
    sent += await ctx.sendToAll(userId, payload);
  }
  return sent;
}

async function handleWeeklyRecap(ctx: Ctx): Promise<number> {
  let sent = 0;
  const RECAP_HOUR = 19;

  for (const userId of ctx.userIds) {
    const tz = ctx.getTimezone(userId);
    const localDow = localDayOfWeek(ctx.now, tz);
    if (localDow !== 6) continue; // Sunday only

    const nowMinutes = localMinutesSinceMidnight(ctx.now, tz);
    const diff = (RECAP_HOUR * 60) - nowMinutes;
    if (diff < -2 || diff > 2) continue;

    const localDate = ctx.now.toLocaleDateString('en-CA', { timeZone: tz });

    // Compute the Monday of this week for the dedup key
    const weekKey = localDate; // Sunday date is unique per week

    if (!await dedup(ctx.supabase, userId, 'weekly_recap', weekKey)) continue;

    // Count completions from the last 7 days
    const sevenDaysAgo = new Date(ctx.now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sinceDate = sevenDaysAgo.toISOString().slice(0, 10);

    const userBlockIds = ctx.blocks
      .filter((b: BlockRow) => b.user_id === userId && b.id)
      .map((b: BlockRow) => b.id);

    let doneCount = 0;
    let totalCount = 0;

    if (userBlockIds.length > 0) {
      // Recurring block completions
      const { data: compRows } = await ctx.supabase
        .from('block_completions')
        .select('status')
        .in('block_id', userBlockIds)
        .gte('completion_date', sinceDate);

      for (const row of (compRows || [])) {
        totalCount++;
        if (row.status === 'done') doneCount++;
      }
    }

    // One-off blocks from the last 7 days
    const oneOffs = ctx.blocks.filter((b: BlockRow) =>
      b.user_id === userId && b.block_date && b.block_date >= sinceDate && b.start_time
    );
    for (const b of oneOffs) {
      totalCount++;
      if (b.status === 'done') doneCount++;
    }

    if (totalCount === 0) continue;

    const pct = Math.round((doneCount / totalCount) * 100);
    const suffix = pct >= 80 ? 'Great week!' : pct >= 50 ? 'Solid progress.' : 'Every bit counts.';

    const payload = JSON.stringify({
      title: 'Your week in review',
      body: `You completed ${doneCount} of ${totalCount} blocks (${pct}%). ${suffix}`,
      icon: '/icons/icon.png',
      tag: 'weekly-recap',
      url: '/', type: 'daily-review',
    });
    sent += await ctx.sendToAll(userId, payload);
  }
  return sent;
}

async function handlePoolNudge(ctx: Ctx, completions: Map<string, string>): Promise<number> {
  let sent = 0;
  const POOL_NUDGE_HOUR = 14; // 2 PM

  for (const userId of ctx.userIds) {
    const tz = ctx.getTimezone(userId);
    const localDate = ctx.now.toLocaleDateString('en-CA', { timeZone: tz });
    const localDow = localDayOfWeek(ctx.now, tz);
    const nowMinutes = localMinutesSinceMidnight(ctx.now, tz);

    const diff = (POOL_NUDGE_HOUR * 60) - nowMinutes;
    if (diff < -2 || diff > 2) continue;

    // Count pool items (no start_time, not completed/skipped/dismissed).
    // Pool items are stored with block_date = null and days = [], so their
    // status lives on the block row itself — match countActivePool in state.ts.
    const poolItems = ctx.blocks.filter((b: BlockRow) => {
      if (b.user_id !== userId) return false;
      if (b.start_time) return false; // scheduled, not pool
      if (b.status === 'done' || b.status === 'skipped' || b.status === 'dismissed') return false;
      return true;
    });
    if (poolItems.length === 0) continue;

    // Only send if the user has NO scheduled blocks today (otherwise
    // the block start/end nudges already cover engagement)
    const scheduledToday = getActiveBlocks(ctx.blocks, userId, localDate, localDow, completions);
    if (scheduledToday.length > 0) continue;

    // Skip if user has been active recently
    const twoHoursAgo = new Date(ctx.now.getTime() - 2 * 60 * 60 * 1000);
    const { count: recentLogs } = await ctx.supabase
      .from('energy_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('logged_at', twoHoursAgo.toISOString());
    if (recentLogs && recentLogs > 0) continue;

    if (!await dedup(ctx.supabase, userId, 'pool_nudge', localDate)) continue;

    const payload = JSON.stringify({
      title: `You've got ${poolItems.length} thing${poolItems.length > 1 ? 's' : ''} in your pool`,
      body: 'Got the energy for one?',
      icon: '/icons/icon.png',
      tag: 'pool-nudge',
      url: '/', type: 'daily-review',
    });
    sent += await ctx.sendToAll(userId, payload);
  }
  return sent;
}

// ── Main handler ────────────────────────────────────────────────────

serve(async (req) => {
  // This function is invoked only by pg_cron (every minute), which sends the
  // service-role key in the Authorization header. Reject anything else —
  // otherwise any authenticated user (or anyone with the public anon key)
  // could spam this endpoint to fan out notifications and burn quota.
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization');
  if (authHeader !== `Bearer ${serviceRoleKey}`) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    serviceRoleKey,
  );

  // Fetch web subscriptions and native device tokens in parallel.
  // Either may be empty independently — a user might have only one channel.
  const [
    { data: subs, error: subsErr },
    { data: tokens, error: tokensErr },
  ] = await Promise.all([
    supabase.from('push_subscriptions').select('*'),
    supabase.from('device_push_tokens').select('*'),
  ]);

  if (subsErr) console.error('[push] fetch push_subscriptions failed:', subsErr.message);
  if (tokensErr) console.error('[push] fetch device_push_tokens failed:', tokensErr.message);

  const subsList: Sub[] = subs || [];
  const tokensList: DeviceToken[] = tokens || [];

  if (subsList.length === 0 && tokensList.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Union of users with any subscription channel — handlers iterate this set.
  const userIdSet = new Set<string>();
  for (const s of subsList) userIdSet.add(s.user_id);
  for (const t of tokensList) userIdSet.add(t.user_id);
  const userIdsArr = [...userIdSet];

  // Fetch shared data once
  const [{ data: reminders }, { data: blocks }] = await Promise.all([
    supabase.from('reminders').select('*').in('user_id', userIdsArr),
    supabase.from('blocks').select('*').in('user_id', userIdsArr),
  ]);

  // Build a completions map for today's recurring blocks (per-user timezone)
  // We fetch all recent completions and let handlers filter per-date
  const blockIds = (blocks || []).filter((b: BlockRow) => !b.block_date && b.id).map((b: BlockRow) => b.id);
  const completions = new Map<string, string>();
  if (blockIds.length > 0) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const { data: compRows } = await supabase
      .from('block_completions')
      .select('block_id,completion_date,status')
      .in('block_id', blockIds)
      .gte('completion_date', yesterday);
    for (const row of (compRows || [])) {
      completions.set(`${row.block_id}_${row.completion_date}`, row.status);
    }
  }

  // Per-user channel + timezone lookups
  const subsByUser = new Map<string, Sub[]>();
  for (const sub of subsList) {
    const list = subsByUser.get(sub.user_id) || [];
    list.push(sub);
    subsByUser.set(sub.user_id, list);
  }

  const tokensByUser = new Map<string, DeviceToken[]>();
  for (const tok of tokensList) {
    const list = tokensByUser.get(tok.user_id) || [];
    list.push(tok);
    tokensByUser.set(tok.user_id, list);
  }

  // Timezone preference: web sub first (existing source of truth), then
  // native token, then UTC fallback.
  const tzByUser = new Map<string, string>();
  for (const sub of subsList) {
    if (!tzByUser.has(sub.user_id)) tzByUser.set(sub.user_id, sub.timezone || 'UTC');
  }
  for (const tok of tokensList) {
    if (!tzByUser.has(tok.user_id)) tzByUser.set(tok.user_id, tok.timezone || 'UTC');
  }
  function getTimezone(userId: string): string {
    return tzByUser.get(userId) || 'UTC';
  }

  // Lazy-init the FCM access token — only mint if a native send actually happens.
  // Token is valid 1h; one mint per invocation amortizes across all sends.
  let fcmAccessToken: string | null | undefined = undefined;
  async function getFcmAccessTokenLazy(): Promise<string | null> {
    if (fcmAccessToken !== undefined) return fcmAccessToken;
    fcmAccessToken = await mintFcmAccessToken();
    return fcmAccessToken;
  }

  async function sendToAll(userId: string, payload: string, opts: SendOpts = {}): Promise<number> {
    let count = 0;

    // Web Push
    const userSubs = subsByUser.get(userId) || [];
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

    // Native (FCM). Skipped for reminders — native clients schedule their
    // own OS-level LocalNotifications, so server-side FCM here would
    // double-fire on the device.
    if (opts.webOnly) return count;

    const userTokens = tokensByUser.get(userId) || [];
    if (userTokens.length > 0) {
      const accessToken = await getFcmAccessTokenLazy();
      if (accessToken) {
        for (const tok of userTokens) {
          try {
            const result = await sendFCM(tok.token, tok.platform, payload, accessToken);
            if (result.status >= 200 && result.status < 300) count++;
            if (result.shouldDelete) {
              await supabase.from('device_push_tokens')
                .delete()
                .eq('user_id', tok.user_id)
                .eq('token', tok.token);
            }
          } catch {
            // network error — skip
          }
        }
      }
    }

    return count;
  }

  const now = new Date();
  const ctx: Ctx = {
    supabase,
    userIds: userIdSet,
    reminders: reminders || [],
    blocks: blocks || [],
    now,
    getTimezone,
    sendToAll,
  };

  const sent = (
    await handleReminders(ctx) +
    await handlePomoTimers(ctx) +
    await handleBlockStartNudge(ctx, completions) +
    await handleBlockEndCheckin(ctx, completions) +
    await handleMorningBrief(ctx, completions) +
    await handleMiddayPulse(ctx, completions) +
    await handleDailyNudge(ctx) +
    await handlePoolNudge(ctx, completions) +
    await handleWeeklyRecap(ctx)
  );

  return new Response(JSON.stringify({ sent }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
