// Supabase Edge Function: Delete the calling user's account.
//
// Authenticated POST. Verifies the caller's JWT, then explicitly deletes their
// rows from every user-data table before calling auth.admin.deleteUser.
// Required by Play Store policy (since 2024) and Apple Guideline 5.1.1(v) for
// any app with account creation.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';

// User-data tables keyed by user_id. Most have ON DELETE CASCADE from
// auth.users, but we delete explicitly for two reasons:
//  1. The base tables (blocks, done_items, energy_logs, pomo_settings,
//     calendar_connections) were created outside the migrations folder so
//     their cascade behavior isn't visible/auditable here.
//  2. Compliance: explicit deletes make it trivial to verify that every
//     user-data table is cleared, which is what store reviewers look for.
//
// Order doesn't matter — every delete is filtered by user_id and runs under
// the service-role client. Child tables (block_completions, reminder_*,
// push_notification_log) cascade from their parents and don't need a row here.
const USER_DATA_TABLES = [
  'blocks',
  'reminders',
  'done_items',
  'energy_logs',
  'pomo_settings',
  'pomo_sessions',
  'pomo_active_timers',
  'calendar_connections',
  'events',
  'knowledge_edges',
  'notification_log',
  'daily_nudge_log',
  'cal_event_seen',
  'energy_checkin_notification_log',
  'push_subscriptions',
  'device_push_tokens',
];

serve(async (req) => {
  if (req.method === 'OPTIONS') return handlePreflight(req);

  const headers = { ...corsHeaders(req), 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers },
    );
  }

  try {
    // 1. Verify the caller's identity from the access token in the auth
    //    header. We only ever delete data for this server-verified user.id —
    //    never for anything in the request body.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers },
      );
    }

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers },
      );
    }

    // 2. Switch to the service-role client. RLS doesn't apply, and
    //    auth.admin.deleteUser requires it.
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 3. Delete user-owned rows from every app table. Errors are logged but
    //    don't abort the loop — leaving rows in one table is a softer
    //    failure than leaving the user signed in with half their data gone.
    const errors: string[] = [];
    for (const table of USER_DATA_TABLES) {
      const { error } = await adminClient
        .from(table)
        .delete()
        .eq('user_id', user.id);
      if (error) {
        console.error(`[delete-account] ${table}: ${error.message}`);
        errors.push(`${table}: ${error.message}`);
      }
    }

    // 4. Delete the auth user. This is the irreversible step — once it
    //    succeeds, the JWT we verified at the top is invalid for any
    //    subsequent request.
    const { error: deleteUserErr } = await adminClient.auth.admin.deleteUser(user.id);
    if (deleteUserErr) {
      console.error('[delete-account] auth.admin.deleteUser:', deleteUserErr);
      return new Response(
        JSON.stringify({ error: 'Failed to delete account', detail: deleteUserErr.message }),
        { status: 500, headers },
      );
    }

    const body: Record<string, unknown> = { ok: true, deleted_user_id: user.id };
    if (errors.length > 0) body.warnings = errors;

    return new Response(JSON.stringify(body), { headers });
  } catch (err) {
    console.error('delete-account error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers },
    );
  }
});
