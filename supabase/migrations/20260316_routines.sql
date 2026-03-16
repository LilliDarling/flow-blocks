-- Reminders table — recurring lightweight tasks (meds, supplements, habits)
-- that live outside of flow blocks with time-based reminders.

CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  reminder_time time NOT NULL,        -- "HH:MM:SS" when reminder fires
  days integer[] NOT NULL DEFAULT '{}', -- [0=Mon..6=Sun]
  icon text NOT NULL DEFAULT '',       -- emoji icon
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reminders_user ON reminders (user_id);

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own reminders"
  ON reminders FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own reminders"
  ON reminders FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own reminders"
  ON reminders FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own reminders"
  ON reminders FOR DELETE USING (auth.uid() = user_id);

-- Reminder completions — daily check-off tracking
CREATE TABLE IF NOT EXISTS reminder_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  completion_date date NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reminder_id, completion_date)
);

CREATE INDEX idx_reminder_completions_date ON reminder_completions (reminder_id, completion_date);

ALTER TABLE reminder_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own reminder completions"
  ON reminder_completions FOR SELECT
  USING (reminder_id IN (SELECT id FROM reminders WHERE user_id = auth.uid()));

CREATE POLICY "Users can insert own reminder completions"
  ON reminder_completions FOR INSERT
  WITH CHECK (reminder_id IN (SELECT id FROM reminders WHERE user_id = auth.uid()));

CREATE POLICY "Users can delete own reminder completions"
  ON reminder_completions FOR DELETE
  USING (reminder_id IN (SELECT id FROM reminders WHERE user_id = auth.uid()));
