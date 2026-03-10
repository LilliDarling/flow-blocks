-- ============================================================
-- Data retention cleanup function
-- Runs on-demand or via pg_cron to keep tables lean.
-- ============================================================

-- Cleanup function that removes stale data beyond retention windows.
-- Call with:  SELECT cleanup_stale_data();
CREATE OR REPLACE FUNCTION cleanup_stale_data()
RETURNS TABLE(
  deleted_completions bigint,
  deleted_done_items bigint,
  deleted_energy_logs bigint,
  deleted_pomo_sessions bigint,
  deleted_oneoff_blocks bigint
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_completions bigint;
  v_done_items bigint;
  v_energy_logs bigint;
  v_pomo_sessions bigint;
  v_oneoff_blocks bigint;
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

  RETURN QUERY SELECT v_completions, v_done_items, v_energy_logs, v_pomo_sessions, v_oneoff_blocks;
END;
$$;

-- ============================================================
-- Schedule daily cleanup at 3:00 AM UTC via pg_cron
-- (Requires the pg_cron extension — enabled by default on Supabase)
-- ============================================================

-- Enable pg_cron if not already active
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Remove any previous schedule for this job name
SELECT cron.unschedule('cleanup-stale-data')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'cleanup-stale-data'
);

-- Run daily at 03:00 UTC
SELECT cron.schedule(
  'cleanup-stale-data',
  '0 3 * * *',
  $$SELECT cleanup_stale_data()$$
);

-- ============================================================
-- Optimize the blocks query: add index for one-off block date lookups
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_blocks_user_date
  ON blocks (user_id, block_date)
  WHERE block_date IS NOT NULL;

-- Index for done_items cleanup & daily queries
CREATE INDEX IF NOT EXISTS idx_done_items_user_created
  ON done_items (user_id, created_at);

-- Index for energy_logs cleanup & analytics window
CREATE INDEX IF NOT EXISTS idx_energy_logs_user_logged
  ON energy_logs (user_id, logged_at);
