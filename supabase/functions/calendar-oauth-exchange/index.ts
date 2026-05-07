// Supabase Edge Function: Exchange OAuth authorization code for tokens
// AND save the connection server-side so refresh_token never touches the
// client. Supports multiple providers — add new ones to the PROVIDERS config.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';

interface ProviderConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Fetch account identity + accessible calendar list using the access token. */
  fetchAccountInfo(accessToken: string): Promise<{
    account_id: string;
    display_name: string;
    calendar_ids: string[];
  }>;
}

function getProviders(): Record<string, ProviderConfig> {
  return {
    google: {
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: Deno.env.get('GOOGLE_CLIENT_ID') || '',
      clientSecret: Deno.env.get('GOOGLE_CLIENT_SECRET') || '',
      async fetchAccountInfo(accessToken) {
        // Email = stable account identifier; cal list determines which
        // calendars we'll later poll.
        let email: string | null = null;
        let calendarIds: string[] = ['primary'];

        try {
          const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (userRes.ok) {
            const data = await userRes.json();
            email = data.email || null;
          }
        } catch {
          // fall through with null email
        }

        try {
          const calRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (calRes.ok) {
            const data = await calRes.json();
            const ids = (data.items || [])
              .filter((c: { accessRole: string }) => c.accessRole === 'owner' || c.accessRole === 'writer')
              .map((c: { id: string }) => c.id);
            if (ids.length > 0) calendarIds = ids;
          }
        } catch {
          // keep default ['primary']
        }

        return {
          account_id: email || 'primary',
          display_name: email ? `Google Calendar (${email})` : 'Google Calendar',
          calendar_ids: calendarIds,
        };
      },
    },
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handlePreflight(req);
  }

  const headers = { ...corsHeaders(req), 'Content-Type': 'application/json' };

  try {
    // 1. Verify the caller is an authenticated user. Without this, anyone
    //    could call this endpoint with a stolen authorization code and bind
    //    a calendar to an arbitrary user_id.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
    }

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
    }

    const { provider: providerId, code, redirect_uri } = await req.json();
    const providers = getProviders();
    const provider = providers[providerId];

    if (!provider) {
      return new Response(
        JSON.stringify({ error: `Unknown provider: ${providerId}` }),
        { status: 400, headers }
      );
    }

    // 2. Exchange authorization code for tokens.
    const tokenRes = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        redirect_uri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      // Don't leak Google's error body to the client — log server-side, return generic.
      const detail = await tokenRes.text();
      console.error('OAuth exchange failed:', detail);
      return new Response(
        JSON.stringify({ error: 'Token exchange failed' }),
        { status: 400, headers }
      );
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token as string;
    const refreshToken = (tokenData.refresh_token as string) || null;
    const expiresIn = (tokenData.expires_in as number) || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // 3. Fetch account identity + calendar list (server-side, using the
    //    short-lived access token we just received).
    const info = await provider.fetchAccountInfo(accessToken);

    // 4. Upsert the connection record using the SERVICE-ROLE client and the
    //    SERVER-VERIFIED user.id — never trust a user_id from the request body.
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: connection, error: upsertErr } = await adminClient
      .from('calendar_connections')
      .upsert(
        {
          user_id: user.id,
          provider: providerId,
          provider_account_id: info.account_id,
          access_token: accessToken,
          refresh_token: refreshToken,
          token_expires_at: expiresAt,
          calendar_ids: info.calendar_ids,
          display_name: info.display_name,
        },
        { onConflict: 'user_id,provider,provider_account_id' }
      )
      .select('id, user_id, provider, provider_account_id, access_token, token_expires_at, calendar_ids, display_name')
      .single();

    if (upsertErr || !connection) {
      console.error('Connection upsert failed:', upsertErr);
      return new Response(
        JSON.stringify({ error: 'Failed to save connection' }),
        { status: 500, headers }
      );
    }

    // 5. Return the saved row WITHOUT refresh_token. Access token is still
    //    needed by the client to call Google directly; refresh_token stays
    //    server-side and is only ever used by calendar-token-refresh.
    return new Response(JSON.stringify({ connection }), { headers });
  } catch (err) {
    console.error('calendar-oauth-exchange error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers }
    );
  }
});
