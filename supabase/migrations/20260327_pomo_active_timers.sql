-- Active pomodoro timers for server-side push notifications.
-- When a user starts a pomo session, the client upserts a row with the
-- expected completion time.  The send-push-notifications cron function
-- picks up any rows whose complete_at has passed and fires a web push.

create table if not exists pomo_active_timers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  complete_at timestamptz not null,
  task text not null default '',
  mode text not null default 'focus'
);

alter table pomo_active_timers enable row level security;

create policy "Users manage own pomo timers"
  on pomo_active_timers for all using (auth.uid() = user_id);
