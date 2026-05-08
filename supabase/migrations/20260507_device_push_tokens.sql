-- ============================================================
-- Native push tokens (FCM / APNs) — one row per device per user
-- ============================================================
--
-- Capacitor's PushNotifications plugin issues a device token (FCM on Android,
-- APNs on iOS — both proxied through FCM HTTP v1 on the server). The client
-- upserts this row from src/push.ts:subscribeToPushNative. The Edge Function
-- reads it to dispatch native pushes alongside Web Push subscriptions.

CREATE TABLE IF NOT EXISTS device_push_tokens (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token      text NOT NULL,
  platform   text NOT NULL CHECK (platform IN ('ios', 'android')),
  timezone   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_device_push_tokens_user
  ON device_push_tokens (user_id);

-- ─────────────────────────────────────────────
-- updated_at trigger (matches the project pattern)
-- ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_device_push_tokens_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS device_push_tokens_touch_updated_at ON device_push_tokens;
CREATE TRIGGER device_push_tokens_touch_updated_at
  BEFORE UPDATE ON device_push_tokens
  FOR EACH ROW EXECUTE FUNCTION touch_device_push_tokens_updated_at();

-- ─────────────────────────────────────────────
-- RLS: a user can only see and modify their own tokens
-- ─────────────────────────────────────────────

ALTER TABLE device_push_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own device push tokens"
  ON device_push_tokens FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own device push tokens"
  ON device_push_tokens FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own device push tokens"
  ON device_push_tokens FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own device push tokens"
  ON device_push_tokens FOR DELETE
  USING (auth.uid() = user_id);
