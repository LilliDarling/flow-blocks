-- ============================================================
-- Event-based storage: events table + knowledge_edges table
-- Adds an append-only event log for all user actions,
-- and a knowledge graph for learned behavioral patterns.
-- ============================================================

-- Clean up from partial runs (safe to run if tables don't exist)
DROP TABLE IF EXISTS events CASCADE;
DROP TABLE IF EXISTS knowledge_edges CASCADE;

-- 1. EVENTS TABLE
-- Stores every user action with contextual metadata.
-- Append-only from the client; only server-side cleanup can delete.

CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type          text NOT NULL,
  entity_id     uuid,
  entity_type   text,
  payload       jsonb NOT NULL DEFAULT '{}',
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Primary insight query pattern: "all block.skipped events for user in last 30 days"
CREATE INDEX idx_events_user_type_time ON events (user_id, type, occurred_at);

-- Full timeline reconstruction: "everything user did today"
CREATE INDEX idx_events_user_time ON events (user_id, occurred_at);

-- Entity history: "what happened to this specific block?"
CREATE INDEX idx_events_entity ON events (entity_id, occurred_at)
  WHERE entity_id IS NOT NULL;

-- Day-of-week pattern queries: "does user skip push blocks on Wednesdays?"
-- Cast to date first (immutable for timestamptz → date at UTC) so EXTRACT is allowed in an index.
CREATE INDEX idx_events_dow ON events (user_id, type, (EXTRACT(DOW FROM occurred_at AT TIME ZONE 'UTC')));

-- ============================================================
-- 2. KNOWLEDGE EDGES TABLE
-- Stores learned relationships between contexts and outcomes.
-- Phase 1: populated by deterministic SQL aggregations.
-- Phase 2: self-adjusting via statistical learning loop.
-- ============================================================

CREATE TABLE knowledge_edges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_node         text NOT NULL,
  target_node         text NOT NULL,
  weight              float DEFAULT 1.0,
  evidence_count      int DEFAULT 1,
  last_reinforced_at  timestamptz DEFAULT now(),
  created_at          timestamptz DEFAULT now(),
  UNIQUE (user_id, source_node, target_node)
);

CREATE INDEX idx_knowledge_edges_user_source
  ON knowledge_edges (user_id, source_node);

-- ============================================================
-- 3. ROW LEVEL SECURITY
-- ============================================================

-- Events: SELECT + INSERT only (immutable from client)
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own events"
  ON events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own events"
  ON events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Knowledge edges: SELECT + INSERT + UPDATE (weights change)
ALTER TABLE knowledge_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own edges"
  ON knowledge_edges FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own edges"
  ON knowledge_edges FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own edges"
  ON knowledge_edges FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- 4. EXTEND DATA RETENTION
-- ============================================================

-- Drop and recreate cleanup function with event retention tiers
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
  deleted_events_ephemeral bigint,
  deleted_events_standard bigint,
  deleted_events_high_value bigint
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
  v_events_ephemeral bigint;
  v_events_standard bigint;
  v_events_high_value bigint;
BEGIN
  -- Existing retention rules (unchanged)

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

  -- Event retention: ephemeral (30 days)
  DELETE FROM events
  WHERE occurred_at < (NOW() - INTERVAL '30 days')
    AND type IN ('app.session_started', 'app.session_resumed', 'pomo.distraction_logged');
  GET DIAGNOSTICS v_events_ephemeral = ROW_COUNT;

  -- Event retention: standard (90 days)
  DELETE FROM events
  WHERE occurred_at < (NOW() - INTERVAL '90 days')
    AND type NOT IN (
      'block.completed', 'block.skipped', 'block.expired', 'energy.logged', 'pomo.session_completed',
      'app.session_started', 'app.session_resumed', 'pomo.distraction_logged'
    );
  GET DIAGNOSTICS v_events_standard = ROW_COUNT;

  -- Event retention: high-value (180 days)
  DELETE FROM events
  WHERE occurred_at < (NOW() - INTERVAL '180 days')
    AND type IN ('block.completed', 'block.skipped', 'block.expired', 'energy.logged', 'pomo.session_completed');
  GET DIAGNOSTICS v_events_high_value = ROW_COUNT;

  RETURN QUERY SELECT v_completions, v_done_items, v_energy_logs, v_pomo_sessions,
    v_oneoff_blocks, v_reminder_completions, v_push_notification_log, v_reminder_skips,
    v_events_ephemeral, v_events_standard, v_events_high_value;
END;
$$;

-- ============================================================
-- 5. BACKFILL EXISTING DATA INTO EVENTS
-- ============================================================

-- Backfill energy_logs → energy.logged events
INSERT INTO events (user_id, type, entity_id, entity_type, payload, occurred_at, created_at)
SELECT
  user_id,
  'energy.logged',
  NULL,
  NULL,
  jsonb_build_object(
    'value', value,
    'tier', CASE
      WHEN value <= 3 THEN 'low'
      WHEN value <= 6 THEN 'med'
      ELSE 'high'
    END,
    'backfill', true
  ),
  logged_at,
  logged_at
FROM energy_logs;

-- Backfill block_completions → block.completed / block.skipped events
INSERT INTO events (user_id, type, entity_id, entity_type, payload, occurred_at, created_at)
SELECT
  b.user_id,
  CASE
    WHEN bc.status = 'done' THEN 'block.completed'
    WHEN bc.status = 'skipped' THEN 'block.skipped'
    ELSE 'block.dismissed'
  END,
  bc.block_id,
  'block',
  jsonb_build_object(
    'date', bc.completion_date,
    'block_type', b.type,
    'title', b.title,
    'backfill', true
  ),
  COALESCE(bc.completed_at, bc.completion_date::timestamptz),
  COALESCE(bc.completed_at, bc.completion_date::timestamptz)
FROM block_completions bc
JOIN blocks b ON b.id = bc.block_id;

-- Backfill pomo_sessions → pomo.session_completed events
INSERT INTO events (user_id, type, entity_id, entity_type, payload, occurred_at, created_at)
SELECT
  user_id,
  'pomo.session_completed',
  id,
  'pomo',
  jsonb_build_object(
    'task', task,
    'duration', duration,
    'distractions', distractions,
    'backfill', true
  ),
  completed_at::timestamptz,
  completed_at::timestamptz
FROM pomo_sessions;

-- Backfill reminder_completions → reminder.completed events
INSERT INTO events (user_id, type, entity_id, entity_type, payload, occurred_at, created_at)
SELECT
  r.user_id,
  'reminder.completed',
  rc.reminder_id,
  'reminder',
  jsonb_build_object(
    'date', rc.completion_date,
    'reminder_name', r.name,
    'backfill', true
  ),
  rc.completed_at::timestamptz,
  rc.completed_at::timestamptz
FROM reminder_completions rc
JOIN reminders r ON r.id = rc.reminder_id;
