-- Tracks which calendar events a user has seen the buffer prompt for.
-- Syncs across devices so the prompt is not shown again after skip/apply.

CREATE TABLE IF NOT EXISTS cal_event_seen (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  seen_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_id, seen_date)
);

ALTER TABLE cal_event_seen ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own cal_event_seen"
  ON cal_event_seen FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "Users can insert own cal_event_seen"
  ON cal_event_seen FOR INSERT
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can delete own cal_event_seen"
  ON cal_event_seen FOR DELETE
  USING (user_id = auth.uid());

-- Clean up old rows daily (retention: 2 days)
CREATE OR REPLACE FUNCTION clean_old_cal_event_seen() RETURNS void AS $$
  DELETE FROM cal_event_seen WHERE seen_date < CURRENT_DATE - INTERVAL '2 days';
$$ LANGUAGE sql SECURITY DEFINER;
