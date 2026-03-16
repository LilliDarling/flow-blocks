-- Rename routines → reminders and routine_completions → reminder_completions
-- Tables were already created by 20260316_routines.sql under the old names.

-- Drop existing policies (can't rename them, so recreate)
DROP POLICY IF EXISTS "Users can view own routines" ON routines;
DROP POLICY IF EXISTS "Users can insert own routines" ON routines;
DROP POLICY IF EXISTS "Users can update own routines" ON routines;
DROP POLICY IF EXISTS "Users can delete own routines" ON routines;

DROP POLICY IF EXISTS "Users can view own routine completions" ON routine_completions;
DROP POLICY IF EXISTS "Users can insert own routine completions" ON routine_completions;
DROP POLICY IF EXISTS "Users can delete own routine completions" ON routine_completions;

-- Drop old indexes (will recreate with new names)
DROP INDEX IF EXISTS idx_routines_user;
DROP INDEX IF EXISTS idx_routine_completions_date;

-- Rename tables
ALTER TABLE routines RENAME TO reminders;
ALTER TABLE routine_completions RENAME TO reminder_completions;

-- Rename the foreign key column
ALTER TABLE reminder_completions RENAME COLUMN routine_id TO reminder_id;

-- Recreate indexes with new names
CREATE INDEX idx_reminders_user ON reminders (user_id);
CREATE INDEX idx_reminder_completions_date ON reminder_completions (reminder_id, completion_date);

-- Recreate RLS policies for reminders
CREATE POLICY "Users can view own reminders"
  ON reminders FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own reminders"
  ON reminders FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own reminders"
  ON reminders FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own reminders"
  ON reminders FOR DELETE USING (auth.uid() = user_id);

-- Recreate RLS policies for reminder_completions
CREATE POLICY "Users can view own reminder completions"
  ON reminder_completions FOR SELECT
  USING (reminder_id IN (SELECT id FROM reminders WHERE user_id = auth.uid()));

CREATE POLICY "Users can insert own reminder completions"
  ON reminder_completions FOR INSERT
  WITH CHECK (reminder_id IN (SELECT id FROM reminders WHERE user_id = auth.uid()));

CREATE POLICY "Users can delete own reminder completions"
  ON reminder_completions FOR DELETE
  USING (reminder_id IN (SELECT id FROM reminders WHERE user_id = auth.uid()));
