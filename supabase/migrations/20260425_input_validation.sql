-- ============================================================
-- Server-side input validation.
--
-- Client code already enforces reasonable limits (title length, menu size,
-- duration, etc.), but the client is not a security boundary — a malicious
-- user of their own account could bypass the UI and insert oversized data
-- into their own rows. RLS prevents cross-user mischief, but not self-bloat
-- that drives up storage and query cost.
--
-- This migration adds CHECK constraints for scalar limits and BEFORE triggers
-- for the more elaborate rules (per-array-element length, pool-size cap).
-- ============================================================

-- ─────────────────────────────────────────────
-- Pre-normalize legacy data so new CHECK constraints don't reject
-- pre-existing rows. Each UPDATE is idempotent; safe to re-run.
-- ─────────────────────────────────────────────

-- Truncate overlong block titles to 200 chars
UPDATE blocks
SET title = LEFT(title, 200)
WHERE char_length(title) > 200;

-- Clamp block duration to the allowed range
UPDATE blocks
SET duration = LEAST(GREATEST(duration, 0), 720)
WHERE duration < 0 OR duration > 720;

-- Truncate oversize menu arrays (keep first 20 items)
UPDATE blocks
SET menu = menu[1:20]
WHERE menu IS NOT NULL AND array_length(menu, 1) > 20;

-- Truncate per-item menu strings to 100 chars
UPDATE blocks
SET menu = ARRAY(SELECT LEFT(m, 100) FROM unnest(menu) AS m)
WHERE menu IS NOT NULL AND EXISTS (
  SELECT 1 FROM unnest(menu) AS m WHERE char_length(m) > 100
);

-- Truncate overlong done_items text
UPDATE done_items
SET text = LEFT(text, 500)
WHERE char_length(text) > 500;

-- Normalize done_items.time to HH:MM 24-hour format. Mirrors the client's
-- normalizeDoneTime() logic: accepts "H:MM" or "H:MM AM/PM", falls back
-- to "00:00" for anything unparseable.
DO $$
DECLARE
  r record;
  parsed text;
  h int;
  m int;
  ampm text;
  match text[];
BEGIN
  FOR r IN SELECT id, time FROM done_items WHERE time !~ '^[0-9]{2}:[0-9]{2}$' LOOP
    match := regexp_match(r.time, '^\s*([0-9]{1,2}):([0-9]{2})\s*(AM|PM)?\s*$', 'i');
    IF match IS NULL THEN
      parsed := '00:00';
    ELSE
      h := match[1]::int;
      m := match[2]::int;
      ampm := UPPER(COALESCE(match[3], ''));
      IF ampm = 'PM' AND h < 12 THEN h := h + 12; END IF;
      IF ampm = 'AM' AND h = 12 THEN h := 0; END IF;
      -- Clamp h to 0-23, m to 0-59 in case of weird inputs
      h := LEAST(GREATEST(h, 0), 23);
      m := LEAST(GREATEST(m, 0), 59);
      parsed := LPAD(h::text, 2, '0') || ':' || LPAD(m::text, 2, '0');
    END IF;
    UPDATE done_items SET time = parsed WHERE id = r.id;
  END LOOP;
END $$;

-- Clamp done_items.duration_minutes to the allowed range
UPDATE done_items
SET duration_minutes = LEAST(duration_minutes, 1440)
WHERE duration_minutes IS NOT NULL AND duration_minutes > 1440;

UPDATE done_items
SET duration_minutes = NULL
WHERE duration_minutes IS NOT NULL AND duration_minutes < 0;

-- Truncate overlong reminder names / icons
UPDATE reminders
SET name = LEFT(name, 100)
WHERE char_length(name) > 100;

UPDATE reminders
SET icon = LEFT(icon, 10)
WHERE char_length(icon) > 10;

-- Drop events with oversize payloads (truncating arbitrary JSON is risky;
-- these are historical pattern data and losing a few is acceptable).
DELETE FROM events
WHERE pg_column_size(payload) > 8192;

-- Clamp out-of-range temporal fields that might exist from client bugs
UPDATE events SET local_dow = NULL WHERE local_dow IS NOT NULL AND (local_dow < 0 OR local_dow > 6);
UPDATE events SET local_hour = NULL WHERE local_hour IS NOT NULL AND (local_hour < 0 OR local_hour > 23);

-- ─────────────────────────────────────────────
-- blocks — scalar CHECKs
-- ─────────────────────────────────────────────

ALTER TABLE blocks
  ADD CONSTRAINT blocks_title_length
    CHECK (char_length(title) <= 200),
  ADD CONSTRAINT blocks_duration_range
    CHECK (duration >= 0 AND duration <= 720),
  ADD CONSTRAINT blocks_menu_count
    CHECK (menu IS NULL OR array_length(menu, 1) IS NULL OR array_length(menu, 1) <= 20),
  ADD CONSTRAINT blocks_days_count
    CHECK (days IS NULL OR array_length(days, 1) IS NULL OR array_length(days, 1) <= 7),
  ADD CONSTRAINT blocks_days_range
    CHECK (days IS NULL OR NOT (days && ARRAY[-1, 7, 8, 9, 10]));

-- Per-menu-item length + pool-size cap via trigger (CHECK can't iterate arrays)
CREATE OR REPLACE FUNCTION validate_block_input()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item text;
  pool_count bigint;
BEGIN
  -- Per-menu-item length cap (100 chars each)
  IF NEW.menu IS NOT NULL THEN
    FOREACH item IN ARRAY NEW.menu LOOP
      IF char_length(item) > 100 THEN
        RAISE EXCEPTION 'Menu item exceeds 100 characters (found % chars)', char_length(item);
      END IF;
    END LOOP;
  END IF;

  -- Defense-in-depth pool-size cap. Client caps at 150 active pool items;
  -- server gives a small buffer for race conditions (multi-device) but
  -- rejects runaway inserts. Counted only when this is a new pool row.
  IF TG_OP = 'INSERT'
     AND NEW.start_time IS NULL
     AND NEW.block_date IS NULL
     AND COALESCE(NEW.status, 'pending') = 'pending' THEN
    SELECT COUNT(*) INTO pool_count
      FROM blocks
     WHERE user_id = NEW.user_id
       AND start_time IS NULL
       AND block_date IS NULL
       AND status = 'pending';
    IF pool_count >= 200 THEN
      RAISE EXCEPTION 'Pool is full (server cap: 200 active items). Complete or remove some before adding more.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS blocks_validate_input ON blocks;
CREATE TRIGGER blocks_validate_input
  BEFORE INSERT OR UPDATE ON blocks
  FOR EACH ROW EXECUTE FUNCTION validate_block_input();

-- ─────────────────────────────────────────────
-- done_items
-- ─────────────────────────────────────────────

ALTER TABLE done_items
  ADD CONSTRAINT done_items_text_length
    CHECK (char_length(text) <= 500),
  ADD CONSTRAINT done_items_time_format
    CHECK (time ~ '^[0-9]{2}:[0-9]{2}$'),
  ADD CONSTRAINT done_items_duration_range
    CHECK (duration_minutes IS NULL OR (duration_minutes >= 0 AND duration_minutes <= 1440));

-- ─────────────────────────────────────────────
-- reminders
-- ─────────────────────────────────────────────

ALTER TABLE reminders
  ADD CONSTRAINT reminders_name_length
    CHECK (char_length(name) <= 100),
  ADD CONSTRAINT reminders_icon_length
    CHECK (char_length(icon) <= 10),
  ADD CONSTRAINT reminders_days_count
    CHECK (days IS NULL OR array_length(days, 1) IS NULL OR array_length(days, 1) <= 7);

-- ─────────────────────────────────────────────
-- events — highest-volume table, so limits are forgiving but present
-- ─────────────────────────────────────────────

ALTER TABLE events
  ADD CONSTRAINT events_type_length
    CHECK (char_length(type) <= 64),
  ADD CONSTRAINT events_entity_type_length
    CHECK (entity_type IS NULL OR char_length(entity_type) <= 32),
  ADD CONSTRAINT events_payload_size
    CHECK (pg_column_size(payload) <= 8192),
  ADD CONSTRAINT events_dow_range
    CHECK (local_dow IS NULL OR (local_dow >= 0 AND local_dow <= 6)),
  ADD CONSTRAINT events_hour_range
    CHECK (local_hour IS NULL OR (local_hour >= 0 AND local_hour <= 23));
