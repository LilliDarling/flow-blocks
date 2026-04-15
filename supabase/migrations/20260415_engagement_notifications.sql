-- ============================================================
-- Generic notification dedup log for all engagement notifications.
-- Replaces per-type tables for new notification kinds.
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  dedup_key text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, notification_type, dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_notification_log_user ON notification_log (user_id);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own notification logs"
  ON notification_log FOR SELECT USING (auth.uid() = user_id);

-- ============================================================
-- Update cleanup function to include new table
-- ============================================================

DROP FUNCTION IF EXISTS cleanup_stale_data();
CREATE OR REPLACE FUNCTION cleanup_stale_data()
RETURNS TABLE(
  deleted_completions bigint,
  deleted_done_items bigint,
  deleted_energy_logs bigint,
  deleted_pomo_sessions bigint,
  deleted_oneoff_blocks bigint,
  deleted_reminder_completions bigint,
  deleted_push_notification_log bigint,
  deleted_reminder_skips bigint,
  deleted_energy_checkin_log bigint,
  deleted_daily_nudge_log bigint,
  deleted_notification_log bigint
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_completions bigint;
  v_done_items bigint;
  v_energy_logs bigint;
  v_pomo_sessions bigint;
  v_oneoff_blocks bigint;
  v_reminder_completions bigint;
  v_push_notification_log bigint;
  v_reminder_skips bigint;
  v_energy_checkin_log bigint;
  v_daily_nudge_log bigint;
  v_notification_log bigint;
BEGIN
  DELETE FROM block_completions
  WHERE completion_date < (CURRENT_DATE - INTERVAL '7 days');
  GET DIAGNOSTICS v_completions = ROW_COUNT;

  DELETE FROM done_items
  WHERE created_at < (NOW() - INTERVAL '30 days');
  GET DIAGNOSTICS v_done_items = ROW_COUNT;

  DELETE FROM energy_logs
  WHERE logged_at < (NOW() - INTERVAL '30 days');
  GET DIAGNOSTICS v_energy_logs = ROW_COUNT;

  DELETE FROM pomo_sessions
  WHERE completed_at < (NOW() - INTERVAL '30 days');
  GET DIAGNOSTICS v_pomo_sessions = ROW_COUNT;

  DELETE FROM blocks
  WHERE block_date IS NOT NULL
    AND block_date::date < (CURRENT_DATE - INTERVAL '7 days');
  GET DIAGNOSTICS v_oneoff_blocks = ROW_COUNT;

  DELETE FROM reminder_completions
  WHERE completion_date < (CURRENT_DATE - INTERVAL '30 days');
  GET DIAGNOSTICS v_reminder_completions = ROW_COUNT;

  DELETE FROM push_notification_log
  WHERE notification_date < (CURRENT_DATE - INTERVAL '2 days');
  GET DIAGNOSTICS v_push_notification_log = ROW_COUNT;

  DELETE FROM reminder_skips
  WHERE skip_date < (CURRENT_DATE - INTERVAL '2 days');
  GET DIAGNOSTICS v_reminder_skips = ROW_COUNT;

  DELETE FROM energy_checkin_notification_log
  WHERE checkin_date < (CURRENT_DATE - INTERVAL '2 days');
  GET DIAGNOSTICS v_energy_checkin_log = ROW_COUNT;

  DELETE FROM daily_nudge_log
  WHERE nudge_date < (CURRENT_DATE - INTERVAL '2 days');
  GET DIAGNOSTICS v_daily_nudge_log = ROW_COUNT;

  DELETE FROM notification_log
  WHERE sent_at < (NOW() - INTERVAL '7 days');
  GET DIAGNOSTICS v_notification_log = ROW_COUNT;

  RETURN QUERY SELECT v_completions, v_done_items, v_energy_logs, v_pomo_sessions, v_oneoff_blocks, v_reminder_completions, v_push_notification_log, v_reminder_skips, v_energy_checkin_log, v_daily_nudge_log, v_notification_log;
END;
$$;
