// Supabase Edge Function: Send Web Push notifications for due reminders.
// Called every minute by pg_cron via pg_net.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'https://esm.sh/web-push@3.6.7';

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') || 'mailto:noreply@flowblocks.app',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

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

  if (!reminders || reminders.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const now = new Date();
  let sent = 0;

  for (const sub of subs) {
    const tz = sub.timezone || 'UTC';

    // 3. Compute local time components in the subscription's timezone
    const localDate = now.toLocaleDateString('en-CA', { timeZone: tz }); // "2026-03-17"
    const localDow = localDayOfWeek(now, tz);
    const nowMinutes = localMinutesSinceMidnight(now, tz);

    // 4. Find reminders due for this user within the send window
    const userReminders = reminders.filter(
      (r: { user_id: string }) => r.user_id === sub.user_id,
    );

    for (const reminder of userReminders) {
      if (!reminder.days.includes(localDow)) continue;

      const [rh, rm] = reminder.reminder_time.slice(0, 5).split(':').map(Number);
      const reminderMinutes = rh * 60 + rm;

      // Send window: 5 minutes before the scheduled time through 5 minutes after
      // (catches early send + missed cron runs)
      const diff = reminderMinutes - nowMinutes;
      if (diff < -5 || diff > 5) continue;

      // 5. Check if already completed or skipped today
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

      // 6. Dedup: try insert, skip if already sent today
      const { error: dedupErr } = await supabase
        .from('push_notification_log')
        .insert({
          reminder_id: reminder.id,
          notification_date: localDate,
        });

      if (dedupErr) continue; // unique violation = already sent

      // 7. Send push notification
      const payload = JSON.stringify({
        title: `${reminder.icon || '💊'} ${reminder.name}`,
        body: `Gentle reminder — it's ${formatTime(reminder.reminder_time.slice(0, 5))}`,
        icon: '/icons/icon.svg',
        tag: `reminder-${reminder.id}`,
        url: '/',
      });

      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        );
        sent++;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 410 || status === 404) {
          // Subscription expired — clean up
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        }
      }
    }
  }

  return new Response(JSON.stringify({ sent }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

/** Get minutes since midnight in the given timezone */
function localMinutesSinceMidnight(date: Date, timezone: string): number {
  const h = parseInt(date.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));
  const m = parseInt(date.toLocaleTimeString('en-GB', { timeZone: timezone, minute: '2-digit' }));
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
