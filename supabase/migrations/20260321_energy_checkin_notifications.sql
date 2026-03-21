-- ============================================================
-- Dedup log for energy check-in push notifications.
-- One notification per user per 2-hour slot per day.
-- ============================================================

CREATE TABLE IF NOT EXISTS energy_checkin_notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  checkin_date date NOT NULL,
  slot_hour smallint NOT NULL,  -- 9, 11, 13, 15, 17, 19
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, checkin_date, slot_hour)
);

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
  deleted_energy_checkin_log bigint
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
BEGIN
  -- 1. block_completions older than 7 days
  DELETE FROM block_completions
  WHERE completion_date < (CURRENT_DATE - INTERVAL '7 days');
  GET DIAGNOSTICS v_completions = ROW_COUNT;

  -- 2. done_items older than 30 days
  DELETE FROM done_items
  WHERE created_at < (NOW() - INTERVAL '30 days');
  GET DIAGNOSTICS v_done_items = ROW_COUNT;

  -- 3. energy_logs older than 30 days
  DELETE FROM energy_logs
  WHERE logged_at < (NOW() - INTERVAL '30 days');
  GET DIAGNOSTICS v_energy_logs = ROW_COUNT;

  -- 4. pomo_sessions older than 30 days
  DELETE FROM pomo_sessions
  WHERE completed_at < (NOW() - INTERVAL '30 days');
  GET DIAGNOSTICS v_pomo_sessions = ROW_COUNT;

  -- 5. One-off blocks whose date is more than 7 days ago
  DELETE FROM blocks
  WHERE block_date IS NOT NULL
    AND block_date::date < (CURRENT_DATE - INTERVAL '7 days');
  GET DIAGNOSTICS v_oneoff_blocks = ROW_COUNT;

  -- 6. reminder_completions older than 30 days
  DELETE FROM reminder_completions
  WHERE completion_date < (CURRENT_DATE - INTERVAL '30 days');
  GET DIAGNOSTICS v_reminder_completions = ROW_COUNT;

  -- 7. push_notification_log older than 2 days
  DELETE FROM push_notification_log
  WHERE notification_date < (CURRENT_DATE - INTERVAL '2 days');
  GET DIAGNOSTICS v_push_notification_log = ROW_COUNT;

  -- 8. reminder_skips older than 2 days
  DELETE FROM reminder_skips
  WHERE skip_date < (CURRENT_DATE - INTERVAL '2 days');
  GET DIAGNOSTICS v_reminder_skips = ROW_COUNT;

  -- 9. energy_checkin_notification_log older than 2 days
  DELETE FROM energy_checkin_notification_log
  WHERE checkin_date < (CURRENT_DATE - INTERVAL '2 days');
  GET DIAGNOSTICS v_energy_checkin_log = ROW_COUNT;

  RETURN QUERY SELECT v_completions, v_done_items, v_energy_logs, v_pomo_sessions, v_oneoff_blocks, v_reminder_completions, v_push_notification_log, v_reminder_skips, v_energy_checkin_log;
END;
$$;
