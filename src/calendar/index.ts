import { supabase } from '../supabase.js';
import type { CalendarConnection, CalendarEvent } from './types.js';
import { registerProvider, getProvider, getAllProviders } from './registry.js';
import { googleProvider } from './google.js';

// Register all built-in providers
registerProvider(googleProvider);

export { getAllProviders, getProvider };
export type { CalendarEvent, CalendarConnection };

/** Load all calendar connections for a user. */
export async function loadConnections(userId: string): Promise<CalendarConnection[]> {
  const { data } = await supabase
    .from('calendar_connections')
    .select('*')
    .eq('user_id', userId);
  return (data || []) as CalendarConnection[];
}

/** Exchange OAuth code for tokens.
 *  Uses direct token exchange for dev; in production, use the edge function instead
 *  to keep client_secret off the client.
 */
async function exchangeCodeForTokens(
  provider: string,
  code: string
): Promise<{ access_token: string; refresh_token: string | null; expires_at: string | null } | null> {
  if (provider === 'google') {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
    const clientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET || '';
    const redirectUri = `${window.location.origin}/auth/google/callback`;

    // Try edge function first, fall back to direct exchange
    const edgeFn = await supabase.functions.invoke('calendar-oauth-exchange', {
      body: { provider, code, redirect_uri: redirectUri },
    }).catch(() => null);

    if (edgeFn?.data?.access_token) {
      return {
        access_token: edgeFn.data.access_token,
        refresh_token: edgeFn.data.refresh_token || null,
        expires_at: edgeFn.data.expires_at || null,
      };
    }

    // Direct exchange (dev fallback — requires VITE_GOOGLE_CLIENT_SECRET)
    if (!clientSecret) {
      console.error('Calendar: No VITE_GOOGLE_CLIENT_SECRET set and edge function unavailable');
      return null;
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!res.ok) {
      console.error('Calendar: Token exchange failed', await res.text());
      return null;
    }

    const data = await res.json();
    const expiresIn = (data.expires_in as number) || 3600;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  return null;
}

/** Fetch the Google account email for the given access token. */
async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.email || null;
  } catch {
    return null;
  }
}

/** Fetch the list of calendar IDs for a Google account. */
async function fetchGoogleCalendarIds(accessToken: string): Promise<string[]> {
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return ['primary'];
    const data = await res.json();
    return (data.items || [])
      .filter((cal: { accessRole: string }) => cal.accessRole === 'owner' || cal.accessRole === 'writer')
      .map((cal: { id: string }) => cal.id);
  } catch {
    return ['primary'];
  }
}

/** Handle the OAuth callback (exchange code for tokens, save connection). */
export async function handleOAuthCallback(
  provider: string,
  code: string,
  userId: string
): Promise<CalendarConnection | null> {
  const tokens = await exchangeCodeForTokens(provider, code);
  if (!tokens) return null;

  // Determine account identity and calendar list
  let accountId = 'primary';
  let displayName = provider;
  let calendarIds = ['primary'];

  if (provider === 'google') {
    const [email, calIds] = await Promise.all([
      fetchGoogleEmail(tokens.access_token),
      fetchGoogleCalendarIds(tokens.access_token),
    ]);
    accountId = email || 'primary';
    displayName = email ? `Google Calendar (${email})` : 'Google Calendar';
    calendarIds = calIds.length > 0 ? calIds : ['primary'];
  }

  // Upsert connection record — keyed by (user, provider, account) so
  // the same Google account updates in place while different accounts coexist
  const { data: conn, error } = await supabase
    .from('calendar_connections')
    .upsert(
      {
        user_id: userId,
        provider,
        provider_account_id: accountId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: tokens.expires_at,
        calendar_ids: calendarIds,
        display_name: displayName,
      },
      { onConflict: 'user_id,provider,provider_account_id' }
    )
    .select()
    .single();

  if (error) {
    console.error('Calendar: Failed to save connection', error);
    return null;
  }

  return (conn as CalendarConnection) || null;
}

/** Fetch today's events from all connected calendars. */
export async function fetchAllEvents(
  connections: CalendarConnection[],
  date: string
): Promise<CalendarEvent[]> {
  const results: CalendarEvent[] = [];

  for (const conn of connections) {
    const provider = getProvider(conn.provider);
    if (!provider) continue;

    try {
      const events = await provider.fetchEvents(conn, date);
      results.push(...events);
    } catch {
      // Skip failed providers gracefully
    }
  }

  return results.sort((a, b) => a.start.localeCompare(b.start));
}

/** Disconnect a calendar connection. */
export async function disconnectCalendar(connectionId: string): Promise<void> {
  await supabase.from('calendar_connections').delete().eq('id', connectionId);
}

/** Check URL for OAuth callback params and handle them. */
export async function checkOAuthRedirect(userId: string): Promise<CalendarConnection | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const pathMatch = url.pathname.match(/\/auth\/(\w+)\/callback/);

  if (!code || !pathMatch) return null;

  const provider = pathMatch[1];
  // Clean the URL
  window.history.replaceState({}, '', '/');

  return handleOAuthCallback(provider, code, userId);
}
