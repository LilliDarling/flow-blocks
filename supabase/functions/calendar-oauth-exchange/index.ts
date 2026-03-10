// Supabase Edge Function: Exchange OAuth authorization code for tokens.
// Supports multiple providers — add new ones to the PROVIDERS config.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';

interface ProviderConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Parse the token response into a normalized shape. */
  parseResponse(data: Record<string, unknown>): {
    access_token: string;
    refresh_token: string | null;
    expires_at: string | null;
    account_id: string;
    display_name: string;
    calendar_ids: string[];
  };
}

function getProviders(): Record<string, ProviderConfig> {
  return {
    google: {
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: Deno.env.get('GOOGLE_CLIENT_ID') || '',
      clientSecret: Deno.env.get('GOOGLE_CLIENT_SECRET') || '',
      parseResponse(data) {
        const expiresIn = (data.expires_in as number) || 3600;
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        return {
          access_token: data.access_token as string,
          refresh_token: (data.refresh_token as string) || null,
          expires_at: expiresAt,
          account_id: 'primary',
          display_name: 'Google Calendar',
          calendar_ids: ['primary'],
        };
      },
    },
    // Add more providers here:
    // notion: { tokenUrl: '...', clientId: '...', ... },
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handlePreflight(req);
  }

  const headers = { ...corsHeaders(req), 'Content-Type': 'application/json' };

  try {
    const { provider: providerId, code, redirect_uri } = await req.json();
    const providers = getProviders();
    const provider = providers[providerId];

    if (!provider) {
      return new Response(
        JSON.stringify({ error: `Unknown provider: ${providerId}` }),
        { status: 400, headers }
      );
    }

    // Exchange authorization code for tokens
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
      const err = await tokenRes.text();
      return new Response(
        JSON.stringify({ error: 'Token exchange failed', details: err }),
        { status: 400, headers }
      );
    }

    const tokenData = await tokenRes.json();
    const result = provider.parseResponse(tokenData);

    return new Response(JSON.stringify(result), { headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers }
    );
  }
});
