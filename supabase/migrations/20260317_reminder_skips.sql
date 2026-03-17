-- Tracks reminders a user has skipped for a given day.
-- Checked by both the client UI and the push notification edge function.

CREATE TABLE IF NOT EXISTS reminder_skips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  skip_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reminder_id, skip_date)
);

ALTER TABLE reminder_skips ENABLE ROW LEVEL SECURITY;

-- RLS: users can manage skips for their own reminders
CREATE POLICY "Users can view own reminder skips"
  ON reminder_skips FOR SELECT
  USING (reminder_id IN (SELECT id FROM reminders WHERE user_id = auth.uid()));
CREATE POLICY "Users can insert own reminder skips"
  ON reminder_skips FOR INSERT
  WITH CHECK (reminder_id IN (SELECT id FROM reminders WHERE user_id = auth.uid()));
CREATE POLICY "Users can delete own reminder skips"
  ON reminder_skips FOR DELETE
  USING (reminder_id IN (SELECT id FROM reminders WHERE user_id = auth.uid()));
