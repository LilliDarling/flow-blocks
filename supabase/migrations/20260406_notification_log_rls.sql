-- ============================================================
-- Add missing RLS to notification log tables
-- ============================================================

-- 1. push_notification_log — scoped through reminder ownership
ALTER TABLE push_notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own push notification logs"
  ON push_notification_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM reminders WHERE reminders.id = push_notification_log.reminder_id
        AND reminders.user_id = auth.uid()
    )
  );

-- Only server (SECURITY DEFINER functions / edge functions) should insert
-- No INSERT policy for regular users — the cron edge function runs as service role

-- 2. energy_checkin_notification_log — has user_id directly
ALTER TABLE energy_checkin_notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own energy checkin logs"
  ON energy_checkin_notification_log FOR SELECT
  USING (auth.uid() = user_id);
