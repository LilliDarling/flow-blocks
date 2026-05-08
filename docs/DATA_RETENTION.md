# Database, Retention & Server-Side Operations

Wildbloom uses Supabase (PostgreSQL) for persistent storage and Edge Functions for server-side logic. This document covers the database schema, security model, data retention, edge functions, secrets, and account deletion.

---

## User-Data Tables

Every table below has a `user_id` column referencing `auth.users(id) ON DELETE CASCADE` and Row Level Security enabled with `auth.uid() = user_id` policies (or, for child tables, an EXISTS join to the parent).

| Table | Purpose | Cascade verified |
|-------|---------|------------------|
| `blocks` | Recurring schedule templates + one-off blocks | ✅ |
| `block_completions` | Daily done/skipped status (joins to `blocks`) | ✅ via parent |
| `done_items` | "Done list" entries logged throughout the day | ✅ |
| `energy_logs` | Energy tier readings (low/med/high) | ✅ |
| `pomo_sessions` | Completed pomodoro focus sessions | ✅ |
| `pomo_settings` | Timer durations, streak, sound preference | ✅ |
| `pomo_active_timers` | Currently-running pomo timer (one row per user) | ✅ |
| `reminders` | Recurring reminders ("take meds", "drink water") | ✅ |
| `reminder_completions` | Daily reminder check-offs (joins to `reminders`) | ✅ via parent |
| `reminder_skips` | Daily skip records for reminders | ✅ via parent |
| `events` | Typed event stream powering the heuristic engine | ✅ |
| `knowledge_edges` | Confirmed pattern weights (insight learning substrate) | ✅ |
| `notification_log` | Generic dedup log (block-start, block-end, midday, etc.) | ✅ |
| `daily_nudge_log` | Per-day dedup for the daily review nudge | ✅ |
| `energy_checkin_notification_log` | Dedup for energy check-in nudges | ✅ |
| `cal_event_seen` | Tracks which calendar events the user has dismissed | ✅ |
| `calendar_connections` | Google Calendar OAuth connections + tokens (server-side) | ✅ |
| `push_subscriptions` | Web Push subscription endpoints (PWA) | ✅ |
| `device_push_tokens` | Native FCM / APNs device tokens (Capacitor) | ✅ |
| `push_notification_log` | Per-reminder per-day dedup log | ✅ via `reminders` |

The cascade audit query lives at the bottom of this doc.

## Row Level Security

Every table has RLS enabled. Standard policies:

- **Direct-user tables**: SELECT/INSERT/UPDATE/DELETE policies all check `auth.uid() = user_id`
- **Child tables** (`block_completions`, `reminder_completions`, `reminder_skips`, `push_notification_log`): RLS uses an EXISTS join through the parent table

Edge Functions that need to read across users (`send-push-notifications`, `delete-account`) use the **service role key** explicitly and verify the caller's identity via the `Authorization` header before touching anything user-scoped.

**Migration:** [supabase/migrations/20260310_enable_rls.sql](../supabase/migrations/20260310_enable_rls.sql)

---

## Data Retention Policy

A scheduled cleanup function runs **daily at 3:00 AM UTC** and removes data past its retention window.

| Data | Retention | Rationale |
|------|-----------|-----------|
| **Recurring blocks** | Indefinite | Schedule templates the user owns |
| **One-off blocks** | 7 days after their date | No longer visible in any view |
| **Block completions** | 7 days | Only today's status is ever queried |
| **Done items** | 30 days | Today's shown; buffer for future features |
| **Energy logs** | 30 days | Analytics chart uses a 14-day window |
| **Pomo sessions** | 30 days | Today's shown; buffer for future features |
| **Pomo settings** | Indefinite | Single row per user, continuously updated |
| **Reminders** | Indefinite | User-owned recurring schedule |
| **Reminder completions** | 30 days | Daily progress; older isn't queried |
| **Events** | 60 days | Long enough for weekly patterns to confirm |
| **Knowledge edges** | Indefinite | Confirmed patterns persist past raw event expiry |
| **Calendar connections** | Indefinite | Active OAuth |
| **Push subscriptions / device tokens** | Indefinite (auto-pruned on 410/UNREGISTERED) | One per device per user |
| **Notification logs** | Each has its own short window for dedup | See cleanup function for specifics |

**Migrations:**
- [supabase/migrations/20260310_data_retention.sql](../supabase/migrations/20260310_data_retention.sql)
- [supabase/migrations/20260424_event_retention.sql](../supabase/migrations/20260424_event_retention.sql) — adds events to the cleanup
- [supabase/migrations/20260426_archive_old_pool_items.sql](../supabase/migrations/20260426_archive_old_pool_items.sql) — pool-block archival rules

### How It Works

1. The PostgreSQL function `cleanup_stale_data()` handles all deletions in one transaction
2. `pg_cron` calls it daily at 03:00 UTC (job name: `cleanup-stale-data`)
3. The function returns a count of deleted rows per table for observability

```sql
-- Run cleanup manually
SELECT * FROM cleanup_stale_data();

-- Inspect cron schedule
SELECT jobid, jobname, schedule, command FROM cron.job;

-- Recent runs (status / duration / errors)
SELECT jobid, status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'cleanup-stale-data')
ORDER BY start_time DESC
LIMIT 10;
```

`pg_cron` is available on Supabase Pro plans and above. On the free tier, `cleanup_stale_data()` exists but must be invoked manually or from a separate edge-function schedule.

---

## Account Deletion

Wildbloom satisfies **Google Play policy (since 2024)** and **Apple Guideline 5.1.1(v)**: an in-app path that permanently removes the account and all associated data.

### Flow

1. **User**: opens the profile modal → clicks "Delete account" → reveals confirmation block → types their email → clicks "Permanently delete"
2. **Client** ([src/auth.ts:handleDeleteAccount](../src/auth.ts)):
   - Captures the user before deletion (need `user.id` for cleanup; the JWT must still be valid for the next step)
   - `supabase.functions.invoke('delete-account')` — POST with the auth header
   - On failure: re-enables the form, shows an error in the feedback area, leaves the user signed in with data intact
   - On success: runs `clearLocalUserData(user.id)` (push unsubscribe + native LocalNotifications cancel + IDB clear + per-user localStorage strip + sessionStorage clear), calls `supabase.auth.signOut()`, then `window.location.replace('/?deleted=1')`
3. **Edge Function** ([supabase/functions/delete-account/index.ts](../supabase/functions/delete-account/index.ts)):
   - Verifies the caller's JWT with the anon-key client + Authorization header → `auth.getUser()`
   - Switches to the service-role client
   - Iterates the 16 user-data tables and runs `DELETE FROM <table> WHERE user_id = <verified-id>`. Errors are logged and accumulated as `warnings` in the response but don't abort the loop
   - Calls `auth.admin.deleteUser(user.id)` as the final irreversible step
4. **Auth screen** renders with `?deleted=1` → `showAuth()` displays "Your account has been deleted." in the feedback area and strips the param via `history.replaceState`

### Why explicit deletes when cascade exists

All 16 user-data tables are confirmed to have `ON DELETE CASCADE` from `auth.users` (audit query below). Explicit deletes still run because:

1. **Compliance audit trail** — Play/App Store reviewers test that account deletion works. Explicit deletes make it trivial to verify every table is cleared (one query per table) instead of relying on opaque cascade behavior
2. **Defense in depth** — if a future migration introduces a non-cascading FK, explicit deletes catch it
3. **Failure isolation** — explicit deletes that complete before `auth.admin.deleteUser` give a partial-success state ("data gone, account still exists") which the user can retry from. Cascade-only would couple the two outcomes

### Cascade audit query

Run in the Supabase SQL Editor to verify every public-schema table that references `auth.users` cascades:

```sql
SELECT
  conrelid::regclass    AS table_name,
  conname               AS constraint_name,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE confrelid = 'auth.users'::regclass
  AND contype = 'f'
ORDER BY conrelid::regclass::text;
```

Every public-schema row's `definition` column should contain `ON DELETE CASCADE`. (Note: `information_schema.referential_constraints` is unreliable for cross-schema FKs in Supabase — always use `pg_catalog`.)

### Local-cleanup helper

Both `handleSignOut` and `handleDeleteAccount` route through the same shared helper:

```ts
clearLocalUserData(userId)
  ├── unsubscribeFromPush(userId)            // Web Push: PushManager.unsubscribe + delete row
  │                                          // Native:   FCM token re-resolve + delete row
  ├── if (isNative):
  │   ├── LocalNotifications.cancel(getPending())  // wipes pomo + reminder OS notifications
  │   └── Browser.close()                          // closes any open in-app OAuth browser
  ├── clearEventQueue()                       // wipes wildbloom-events IDB store
  ├── localStorage.removeItem('hidden_cal_*') // per-user calendar-event-hide overrides
  └── sessionStorage.clear()
```

Theme and the date-keyed sweep timestamp in localStorage are intentionally preserved (not user-specific).

---

## Migrations

Run in chronological order via `supabase db push` or paste into the Supabase SQL Editor:

| # | File | Purpose |
|---|------|---------|
| 1 | [`20260310_enable_rls.sql`](../supabase/migrations/20260310_enable_rls.sql) | Enables RLS on the base tables (blocks, completions, done_items, energy_logs, pomo_settings, calendar_connections) |
| 2 | [`20260310_pomo_sessions.sql`](../supabase/migrations/20260310_pomo_sessions.sql) | Creates `pomo_sessions` |
| 3 | [`20260310_data_retention.sql`](../supabase/migrations/20260310_data_retention.sql) | Cleanup function + pg_cron + indexes |
| 4 | [`20260316_routines.sql`](../supabase/migrations/20260316_routines.sql) | Creates the original routines/reminders schema |
| 5 | [`20260316_rename_routines_to_reminders.sql`](../supabase/migrations/20260316_rename_routines_to_reminders.sql) | Renames `routines` → `reminders` (the FK constraint name remains `routines_user_id_fkey` for legacy reasons — harmless) |
| 6 | [`20260317_push_subscriptions.sql`](../supabase/migrations/20260317_push_subscriptions.sql) | Creates `push_subscriptions` + dedup log + pg_cron job invoking the push function every minute |
| 7 | [`20260317_reminder_skips.sql`](../supabase/migrations/20260317_reminder_skips.sql) | Adds reminder skip tracking |
| 8 | [`20260319_block_completion_timestamp.sql`](../supabase/migrations/20260319_block_completion_timestamp.sql) | Adds `completed_at` to block_completions |
| 9 | [`20260321_energy_checkin_notifications.sql`](../supabase/migrations/20260321_energy_checkin_notifications.sql) | Energy check-in nudge dedup table |
| 10 | [`20260327_pomo_active_timers.sql`](../supabase/migrations/20260327_pomo_active_timers.sql) | Server-side pomo completion source for Web Push |
| 11 | [`20260402_events_table.sql`](../supabase/migrations/20260402_events_table.sql) | Event stream + knowledge edges (heuristic engine substrate) |
| 12 | [`20260406_notification_log_rls.sql`](../supabase/migrations/20260406_notification_log_rls.sql) | RLS for notification logs |
| 13 | [`20260409_cal_event_seen.sql`](../supabase/migrations/20260409_cal_event_seen.sql) | Tracks calendar events the user has dismissed |
| 14 | [`20260411_allow_null_start_time.sql`](../supabase/migrations/20260411_allow_null_start_time.sql) | Schema relaxation for pool blocks |
| 15 | [`20260413_daily_nudge.sql`](../supabase/migrations/20260413_daily_nudge.sql) | Daily review nudge dedup |
| 16 | [`20260415_engagement_notifications.sql`](../supabase/migrations/20260415_engagement_notifications.sql) | Generic notification dedup table |
| 17 | [`20260424_done_item_duration.sql`](../supabase/migrations/20260424_done_item_duration.sql) | Adds duration to done_items |
| 18 | [`20260424_event_retention.sql`](../supabase/migrations/20260424_event_retention.sql) | Extends cleanup to events table |
| 19 | [`20260425_input_validation.sql`](../supabase/migrations/20260425_input_validation.sql) | Server-side validation guards |
| 20 | [`20260426_archive_old_pool_items.sql`](../supabase/migrations/20260426_archive_old_pool_items.sql) | Pool block archival rules |
| 21 | [`20260501_daily_nudge_log_rls.sql`](../supabase/migrations/20260501_daily_nudge_log_rls.sql) | Hardens RLS on daily_nudge_log |
| 22 | [`20260507_device_push_tokens.sql`](../supabase/migrations/20260507_device_push_tokens.sql) | Native push tokens for Capacitor (FCM/APNs) |

---

## Edge Functions

| Function | Path | Purpose |
|----------|------|---------|
| `calendar-oauth-exchange` | [supabase/functions/calendar-oauth-exchange/](../supabase/functions/calendar-oauth-exchange/) | Exchanges Google OAuth code for tokens, upserts the connection row server-side (refresh token never reaches the client) |
| `calendar-token-refresh` | [supabase/functions/calendar-token-refresh/](../supabase/functions/calendar-token-refresh/) | Refreshes expired calendar access tokens |
| `send-push-notifications` | [supabase/functions/send-push-notifications/](../supabase/functions/send-push-notifications/) | Cron-triggered every minute. Reads `push_subscriptions` (Web Push) and `device_push_tokens` (native FCM) and dispatches reminders, pomo completions, block-start/end nudges, daily/midday/weekly nudges. Handles 410/UNREGISTERED by deleting the dead row |
| `delete-account` | [supabase/functions/delete-account/](../supabase/functions/delete-account/) | Authenticated POST. Verifies the caller's JWT, deletes their rows from every user-data table, then calls `auth.admin.deleteUser` |
| `_shared/cors.ts` | [supabase/functions/_shared/cors.ts](../supabase/functions/_shared/cors.ts) | Shared CORS module with origin allowlist |

### Deploying

```bash
supabase functions deploy calendar-oauth-exchange
supabase functions deploy calendar-token-refresh
supabase functions deploy send-push-notifications
supabase functions deploy delete-account
```

### Required Secrets

Set via the Supabase dashboard (Settings → Edge Functions → Secrets) or CLI:

```bash
# CORS
supabase secrets set ALLOWED_ORIGINS="https://app.growingme.co,http://localhost:5173"

# Google Calendar OAuth (calendar-oauth-exchange + calendar-token-refresh)
supabase secrets set GOOGLE_CLIENT_ID="…"
supabase secrets set GOOGLE_CLIENT_SECRET="…"

# Web Push / VAPID (send-push-notifications, web subscribers)
supabase secrets set VAPID_PUBLIC_KEY="…"
supabase secrets set VAPID_PRIVATE_KEY="…"
supabase secrets set VAPID_SUBJECT="mailto:support@yourdomain.com"

# Native push / FCM HTTP v1 (send-push-notifications, native subscribers)
supabase secrets set FCM_PROJECT_ID="your-firebase-project-id"
supabase secrets set FCM_SERVICE_ACCOUNT_KEY="$(cat fcm-service-account.json)"
```

`GOOGLE_CLIENT_SECRET`, `VAPID_PRIVATE_KEY`, and `FCM_SERVICE_ACCOUNT_KEY` are **only** stored in edge function secrets — never client-side. Delete the local copy of the FCM service account JSON after `supabase secrets set` succeeds.

---

## Database Indexes

| Index | Table | Columns | Purpose |
|-------|-------|---------|---------|
| `idx_blocks_user_date` | `blocks` | `(user_id, block_date)` WHERE `block_date IS NOT NULL` | Fast one-off block lookups + cleanup |
| `idx_done_items_user_created` | `done_items` | `(user_id, created_at)` | Daily query + retention cleanup |
| `idx_energy_logs_user_logged` | `energy_logs` | `(user_id, logged_at)` | Analytics window + retention cleanup |
| `idx_pomo_sessions_user_date` | `pomo_sessions` | `(user_id, completed_at)` | Daily sessions query + cleanup |
| `idx_push_subs_user` | `push_subscriptions` | `(user_id)` | Edge function fan-out |
| `idx_device_push_tokens_user` | `device_push_tokens` | `(user_id)` | Edge function fan-out (native) |

---

## Scaling Notes

At 100 active users, expected daily row creation:

| Table | Rows/Day (100 users) | Steady-state under retention |
|-------|---------------------|-------------------------------|
| `block_completions` | ~500-1000 | ~3,500-7,000 (7-day retention) |
| `done_items` | ~300-500 | ~9,000-15,000 (30-day cap) |
| `energy_logs` | ~400-800 | ~12,000-24,000 (30-day cap) |
| `pomo_sessions` | ~300-500 | ~9,000-15,000 (30-day cap) |
| `events` | ~3,000-5,000 | ~180,000-300,000 (60-day cap) |

The `events` table is the largest consumer; the 60-day window keeps it bounded. Beyond ~1,000 users, consider:

- Partitioning `events` by month
- Archiving `knowledge_edges` aggregates before raw event expiry (already designed for this — edges persist past events)
- Monitoring `pg_cron` job duration in `cron.job_run_details`
