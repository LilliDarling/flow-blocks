-- Track how long a completed item took. Optional: old rows and ad-hoc log
-- entries (e.g. "log something else") may omit it.
ALTER TABLE done_items
  ADD COLUMN IF NOT EXISTS duration_minutes integer;
