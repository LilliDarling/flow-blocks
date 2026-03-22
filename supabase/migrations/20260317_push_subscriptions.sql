-- ============================================================
-- Push subscriptions + notification dedup for Web Push reminders
-- ============================================================

-- Stores one push subscription per device per user.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own push subscriptions"
  ON push_subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own push subscriptions"
  ON push_subscriptions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own push subscriptions"
  ON push_subscriptions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own push subscriptions"
  ON push_subscriptions FOR DELETE USING (auth.uid() = user_id);

-- Deduplication log: one notification per reminder per day.
-- Insert with ON CONFLICT DO NOTHING — if the row already exists, skip.
CREATE TABLE IF NOT EXISTS push_notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  notification_date date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reminder_id, notification_date)
);

-- ============================================================
-- pg_cron + pg_net: call the edge function every minute
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('send-push-notifications')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'send-push-notifications'
);

SELECT cron.schedule(
  'send-push-notifications',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://yclaroxofbceouhxpeof.supabase.co/functions/v1/send-push-notifications',
    headers := '{"Authorization": "Bearer ' || current_setting('supabase.service_role_key', true) || '", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
