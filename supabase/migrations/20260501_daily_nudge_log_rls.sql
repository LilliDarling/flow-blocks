-- ============================================================
-- Add SELECT policy for daily_nudge_log.
-- RLS was enabled in 20260413_daily_nudge.sql but no policies were defined,
-- so users couldn't read their own nudge history. Service-role inserts from
-- the send-push-notifications edge function bypass RLS, so no INSERT policy
-- is needed (matches the pattern in 20260406_notification_log_rls.sql).
-- ============================================================

CREATE POLICY "Users can view own daily nudge logs"
  ON daily_nudge_log FOR SELECT
  USING (auth.uid() = user_id);
