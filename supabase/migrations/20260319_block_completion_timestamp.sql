-- Add timestamp to block completions so we can track when blocks are actually completed,
-- not just which date they were marked done.
ALTER TABLE block_completions
  ADD COLUMN IF NOT EXISTS completed_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_block_completions_completed_at
  ON block_completions (completed_at)
  WHERE completed_at IS NOT NULL;
