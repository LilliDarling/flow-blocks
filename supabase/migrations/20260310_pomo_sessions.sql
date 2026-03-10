-- Pomo sessions table — stores completed focus sessions across all devices.
-- Each row is one completed pomodoro.

CREATE TABLE IF NOT EXISTS pomo_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task text NOT NULL DEFAULT '',
  duration integer NOT NULL,         -- minutes
  distractions integer NOT NULL DEFAULT 0,
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast "today's sessions" queries
CREATE INDEX idx_pomo_sessions_user_date ON pomo_sessions (user_id, completed_at);

-- RLS
ALTER TABLE pomo_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own pomo sessions"
  ON pomo_sessions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own pomo sessions"
  ON pomo_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own pomo sessions"
  ON pomo_sessions FOR DELETE
  USING (auth.uid() = user_id);
