-- Enable Row Level Security on all user-facing tables.
-- Each table uses auth.uid() to ensure users can only access their own data.
-- Run this in the Supabase SQL editor or via `supabase db push`.

-- ============================================================
-- 1. BLOCKS
-- ============================================================
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own blocks"
  ON blocks FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own blocks"
  ON blocks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own blocks"
  ON blocks FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own blocks"
  ON blocks FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================================
-- 2. BLOCK_COMPLETIONS
-- ============================================================
ALTER TABLE block_completions ENABLE ROW LEVEL SECURITY;

-- Completions reference blocks, so we join to verify ownership
CREATE POLICY "Users can view own completions"
  ON block_completions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM blocks WHERE blocks.id = block_completions.block_id
        AND blocks.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own completions"
  ON block_completions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM blocks WHERE blocks.id = block_completions.block_id
        AND blocks.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own completions"
  ON block_completions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM blocks WHERE blocks.id = block_completions.block_id
        AND blocks.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own completions"
  ON block_completions FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM blocks WHERE blocks.id = block_completions.block_id
        AND blocks.user_id = auth.uid()
    )
  );

-- ============================================================
-- 3. DONE_ITEMS
-- ============================================================
ALTER TABLE done_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own done items"
  ON done_items FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own done items"
  ON done_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own done items"
  ON done_items FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================================
-- 4. ENERGY_LOGS
-- ============================================================
ALTER TABLE energy_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own energy logs"
  ON energy_logs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own energy logs"
  ON energy_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- 5. POMO_SETTINGS
-- ============================================================
ALTER TABLE pomo_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own pomo settings"
  ON pomo_settings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own pomo settings"
  ON pomo_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own pomo settings"
  ON pomo_settings FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- 6. CALENDAR_CONNECTIONS
-- ============================================================
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own calendar connections"
  ON calendar_connections FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own calendar connections"
  ON calendar_connections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own calendar connections"
  ON calendar_connections FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own calendar connections"
  ON calendar_connections FOR DELETE
  USING (auth.uid() = user_id);
