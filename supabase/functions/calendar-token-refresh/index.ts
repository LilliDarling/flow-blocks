// Supabase Edge Function: Refresh an expired OAuth access token.
// Updates the calendar_connections row with the new token.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';

interface RefreshConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

function getRefreshConfig(provider: string): RefreshConfig | null {
  const configs: Record<string, RefreshConfig> = {
    google: {
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: Deno.env.get('GOOGLE_CLIENT_ID') || '',
      clientSecret: Deno.env.get('GOOGLE_CLIENT_SECRET') || '',
    },
  };
  return configs[provider] || null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handlePreflight(req);
  }

  const headers = { ...corsHeaders(req), 'Content-Type': 'application/json' };

  try {
    // 1. Verify the caller is an authenticated user. Without this, anyone
    //    could refresh any connection's token by passing connection_id +
    //    refresh_token.
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

    const { provider, connection_id } = await req.json();
    const config = getRefreshConfig(provider);

    if (!config) {
      return new Response(
        JSON.stringify({ error: `Unknown provider: ${provider}` }),
        { status: 400, headers }
      );
    }

    // 2. Look up the connection server-side (service role) and verify the
    //    caller owns it. Using the stored refresh_token rather than one
    //    supplied by the client closes the gap where an attacker could pass
    //    a victim's refresh_token + their own connection_id (or vice versa).
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: connection, error: connErr } = await adminClient
      .from('calendar_connections')
      .select('id, user_id, refresh_token, provider')
      .eq('id', connection_id)
      .single();

    if (connErr || !connection) {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
    }

    if (connection.user_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers });
    }

    if (connection.provider !== provider) {
      return new Response(JSON.stringify({ error: 'Provider mismatch' }), { status: 400, headers });
    }

    if (!connection.refresh_token) {
      return new Response(
        JSON.stringify({ error: 'No refresh token on record' }),
        { status: 400, headers }
      );
    }

    // 3. Refresh against the provider.
    const tokenRes = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: connection.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!tokenRes.ok) {
      const detail = await tokenRes.text();
      console.error('Token refresh failed:', detail);
      return new Response(
        JSON.stringify({ error: 'Token refresh failed' }),
        { status: 400, headers }
      );
    }

    const data = await tokenRes.json();
    const expiresIn = (data.expires_in as number) || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const accessToken = data.access_token as string;

    // 4. Update the connection row.
    await adminClient
      .from('calendar_connections')
      .update({ access_token: accessToken, token_expires_at: expiresAt })
      .eq('id', connection_id);

    return new Response(
      JSON.stringify({ access_token: accessToken, expires_at: expiresAt }),
      { headers }
    );
  } catch (err) {
    console.error('calendar-token-refresh error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers }
    );
  }
});
