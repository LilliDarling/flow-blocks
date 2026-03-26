# Data Retention & Database Management

Wildbloom uses Supabase (PostgreSQL) for persistent storage. This document covers the database schema, security model, data retention policies, and deployment steps.

---

## Database Tables

| Table | Purpose | Row Growth |
|-------|---------|------------|
| `blocks` | Recurring schedule templates + one-off blocks | Low (recurring reused; one-offs auto-cleaned) |
| `block_completions` | Daily done/skipped status for recurring blocks | ~N recurring blocks per day per user |
| `done_items` | "Done list" entries logged throughout the day | Several per day per user |
| `energy_logs` | Energy slider readings (1-10 scale) | Multiple per day per user |
| `pomo_sessions` | Completed pomodoro focus sessions | ~5-8 per day for active users |
| `pomo_settings` | Timer durations, streak, sound preference | 1 row per user (upserted) |
| `calendar_connections` | Google Calendar OAuth connections | 1 row per connected calendar |

## Security: Row Level Security (RLS)

Every table has RLS enabled. Policies ensure users can only SELECT, INSERT, UPDATE, and DELETE their own rows via `auth.uid() = user_id`.

`block_completions` verifies ownership through a JOIN to the parent `blocks` table since it doesn't have its own `user_id` column.

**Migration:** `supabase/migrations/20260310_enable_rls.sql`

## Data Retention Policy

A scheduled cleanup function runs **daily at 3:00 AM UTC** and removes data past its retention window:

| Data | Retention | Rationale |
|------|-----------|-----------|
| **Recurring blocks** | Indefinite | These are the user's schedule templates |
| **One-off blocks** | 7 days after their date | No longer visible in any view |
| **Block completions** | 7 days | Only today's status is ever queried |
| **Done items** | 30 days | Only today's shown, but buffer for future features |
| **Energy logs** | 30 days | Analytics chart uses a 14-day window |
| **Pomo sessions** | 30 days | Only today's shown, but buffer for future features |
| **Pomo settings** | Indefinite | Single row per user, continuously updated |
| **Calendar connections** | Indefinite | Active OAuth connections |

**Migration:** `supabase/migrations/20260310_data_retention.sql`

### How It Works

1. A PostgreSQL function `cleanup_stale_data()` handles all deletions in a single transaction
2. `pg_cron` calls it daily at 03:00 UTC (job name: `cleanup-stale-data`)
3. The function returns a count of deleted rows per table for observability

### Running Cleanup Manually

```sql
SELECT * FROM cleanup_stale_data();
```

Returns:

| deleted_completions | deleted_done_items | deleted_energy_logs | deleted_pomo_sessions | deleted_oneoff_blocks |
|--------------------:|-------------------:|--------------------:|----------------------:|----------------------:|
| 42                  | 15                 | 230                 | 28                    | 5                     |

### Checking the Cron Schedule

```sql
SELECT jobid, jobname, schedule, command FROM cron.job;
```

### pg_cron Availability

`pg_cron` is available on **Supabase Pro plans** and above. On the free tier, the `cleanup_stale_data()` function still exists — you can call it manually or trigger it from an edge function on a schedule.

## Database Indexes

| Index | Table | Columns | Purpose |
|-------|-------|---------|---------|
| `idx_blocks_user_date` | `blocks` | `(user_id, block_date)` WHERE `block_date IS NOT NULL` | Fast one-off block lookups + cleanup |
| `idx_done_items_user_created` | `done_items` | `(user_id, created_at)` | Daily query + retention cleanup |
| `idx_energy_logs_user_logged` | `energy_logs` | `(user_id, logged_at)` | Analytics window + retention cleanup |
| `idx_pomo_sessions_user_date` | `pomo_sessions` | `(user_id, completed_at)` | Daily sessions query + cleanup |

## Query Optimizations

The blocks query in `src/state.ts` filters server-side to avoid loading stale one-off blocks:

```typescript
.or(`block_date.is.null,block_date.gte.${cutoffDate}`)  // recurring + last 7 days
```

This keeps the initial data load fast even as users create one-off blocks over months.

---

## Migrations

Run these in order in the **Supabase SQL Editor** or via `supabase db push`:

| # | File | What It Does |
|---|------|-------------|
| 1 | `supabase/migrations/20260310_enable_rls.sql` | Enables RLS on all tables with per-user policies |
| 2 | `supabase/migrations/20260310_pomo_sessions.sql` | Creates `pomo_sessions` table with RLS + index |
| 3 | `supabase/migrations/20260310_data_retention.sql` | Creates cleanup function, pg_cron schedule, and indexes |

## Edge Functions

| Function | Path | Purpose |
|----------|------|---------|
| `calendar-oauth-exchange` | `supabase/functions/calendar-oauth-exchange/` | Exchanges OAuth code for tokens (keeps client_secret server-side) |
| `calendar-token-refresh` | `supabase/functions/calendar-token-refresh/` | Refreshes expired calendar access tokens |
| `_shared/cors.ts` | `supabase/functions/_shared/cors.ts` | Shared CORS module with origin allowlist |

### Deploying Edge Functions

```bash
supabase functions deploy calendar-oauth-exchange
supabase functions deploy calendar-token-refresh
```

### Required Secrets

Set these via the Supabase dashboard (Settings > Edge Functions) or CLI:

```bash
supabase secrets set GOOGLE_CLIENT_ID=your-client-id
supabase secrets set GOOGLE_CLIENT_SECRET=your-client-secret
supabase secrets set ALLOWED_ORIGINS=https://yourdomain.com,http://localhost:5173
```

`GOOGLE_CLIENT_SECRET` is **only** stored in edge function secrets — never in client-side code.

---

## Scaling Notes

At 100+ users, expected daily row creation:

| Table | Rows/Day (100 users) | Rows After 30 Days |
|-------|---------------------|-------------------|
| `block_completions` | ~500-1000 | ~3,500-7,000 (7-day retention) |
| `done_items` | ~300-500 | ~9,000-15,000 (30-day cap) |
| `energy_logs` | ~400-800 | ~12,000-24,000 (30-day cap) |
| `pomo_sessions` | ~300-500 | ~9,000-15,000 (30-day cap) |

With retention policies active, no table exceeds ~25K rows at 100 users. The indexes ensure cleanup queries and daily lookups stay fast.

If you grow beyond 1000 users, consider:
- Partitioning `energy_logs` by month
- Archiving aggregated analytics data before deletion
- Monitoring `pg_cron` job duration in `cron.job_run_details`

```sql
-- Check recent cleanup runs
SELECT jobid, status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'cleanup-stale-data')
ORDER BY start_time DESC
LIMIT 10;
```
