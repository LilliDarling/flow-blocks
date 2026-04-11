-- Allow blocks to have no start time (pool/unscheduled items).
-- Previously all blocks required a start_time. Now blocks without a time
-- live in the "available" pool and get surfaced by energy match instead.
ALTER TABLE blocks ALTER COLUMN start_time DROP NOT NULL;
