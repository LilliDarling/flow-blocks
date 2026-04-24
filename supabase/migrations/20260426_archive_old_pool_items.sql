-- ============================================================
-- Pool archival: clean up completed/skipped/dismissed pool items
-- after 30 days of sitting in terminal state.
--
-- Context: one-off dated blocks are already cleaned 7 days after their
-- date, and recurring-block completions are tracked in block_completions
-- (30-day retention). But pool items — blocks with no start_time, no
-- block_date, and no recurring days — had no retention policy. Once a
-- user marked one done/skipped/dismissed it sat in `blocks` forever,
-- invisible in the UI but padding state.blocks and storage.
--
-- The completion record itself is preserved: done_items (30d), events
-- (60d), and block_completions (for recurring). Deleting the block row
-- after 30 days of terminal status loses no user-facing information.
-- ============================================================

-- ─────────────────────────────────────────────
-- Add updated_at with auto-update trigger
-- ─────────────────────────────────────────────

ALTER TABLE blocks
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Backfill for existing rows
UPDATE blocks SET updated_at = created_at WHERE updated_at IS NULL;

CREATE OR REPLACE FUNCTION touch_blocks_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS blocks_touch_updated_at ON blocks;
CREATE TRIGGER blocks_touch_updated_at
  BEFORE UPDATE ON blocks
  FOR EACH ROW EXECUTE FUNCTION touch_blocks_updated_at();

-- Helpful index for the cleanup query
CREATE INDEX IF NOT EXISTS idx_blocks_terminal_pool
  ON blocks (updated_at)
  WHERE start_time IS NULL
    AND block_date IS NULL
    AND status IN ('done', 'skipped', 'dismissed');

-- ─────────────────────────────────────────────
-- Extend cleanup function to archive old pool items
-- ─────────────────────────────────────────────

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
  deleted_notification_log bigint,
  deleted_events bigint,
  deleted_archived_pool bigint
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
  v_events bigint;
  v_archived_pool bigint;
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

  DELETE FROM events
  WHERE occurred_at < (NOW() - INTERVAL '60 days');
  GET DIAGNOSTICS v_events = ROW_COUNT;

  -- Pool items in terminal state for 30+ days. The "pool" filter matches
  -- the client: no start_time, no block_date, no recurring days.
  DELETE FROM blocks
  WHERE start_time IS NULL
    AND block_date IS NULL
    AND (days IS NULL OR cardinality(days) = 0)
    AND status IN ('done', 'skipped', 'dismissed')
    AND updated_at < (NOW() - INTERVAL '30 days');
  GET DIAGNOSTICS v_archived_pool = ROW_COUNT;

  RETURN QUERY SELECT v_completions, v_done_items, v_energy_logs, v_pomo_sessions, v_oneoff_blocks, v_reminder_completions, v_push_notification_log, v_reminder_skips, v_energy_checkin_log, v_daily_nudge_log, v_notification_log, v_events, v_archived_pool;
END;
$$;
