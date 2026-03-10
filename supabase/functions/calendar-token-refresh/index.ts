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
    // Add more providers here
  };
  return configs[provider] || null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handlePreflight(req);
  }

  const headers = { ...corsHeaders(req), 'Content-Type': 'application/json' };

  try {
    const { provider, connection_id, refresh_token } = await req.json();
    const config = getRefreshConfig(provider);

    if (!config) {
      return new Response(
        JSON.stringify({ error: `Unknown provider: ${provider}` }),
        { status: 400, headers }
      );
    }

    const tokenRes = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return new Response(
        JSON.stringify({ error: 'Token refresh failed', details: err }),
        { status: 400, headers }
      );
    }

    const data = await tokenRes.json();
    const expiresIn = (data.expires_in as number) || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const accessToken = data.access_token as string;

    // Update the connection record in the database
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    await supabase
      .from('calendar_connections')
      .update({ access_token: accessToken, token_expires_at: expiresAt })
      .eq('id', connection_id);

    return new Response(
      JSON.stringify({ access_token: accessToken, expires_at: expiresAt }),
      { headers }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers }
    );
  }
});
