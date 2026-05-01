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

/** Handle the OAuth callback. The edge function exchanges the code, fetches
 *  account info, and upserts the connection server-side using the verified
 *  caller's user.id — refresh_token never crosses the wire to the client.
 *  The userId param is kept for API compatibility but not trusted server-side.
 */
export async function handleOAuthCallback(
  provider: string,
  code: string,
  _userId: string
): Promise<CalendarConnection | null> {
  const redirectUri = `${window.location.origin}/auth/${provider}/callback`;

  try {
    const { data, error } = await supabase.functions.invoke('calendar-oauth-exchange', {
      body: { provider, code, redirect_uri: redirectUri },
    });

    if (error || !data?.connection) {
      console.error('Calendar: OAuth exchange failed', error);
      return null;
    }

    return data.connection as CalendarConnection;
  } catch (err) {
    console.error('Calendar: OAuth exchange unavailable', err);
    return null;
  }
}

/** Max events retained per day after merging across connected calendars. */
const MAX_EVENTS_PER_DAY = 60;

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

  // De-dupe: same event synced across overlapping calendars would land twice.
  // Keep the first occurrence by normalized id.
  const seen = new Set<string>();
  const deduped = results.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  // Sort by start, then cap per-day so a user with 5 connected calendars
  // doesn't push hundreds of events through the week-view layout engine.
  return deduped
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, MAX_EVENTS_PER_DAY);
}

/** Revoke an OAuth token so it can no longer be used. Best-effort — don't block on failure. */
async function revokeToken(connection: CalendarConnection): Promise<void> {
  if (connection.provider !== 'google') return;

  const token = connection.access_token || connection.refresh_token;
  if (!token) return;

  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch {
    // Best-effort — token may already be expired/revoked
  }
}

/** Disconnect a calendar connection — revokes the token then deletes the record. */
export async function disconnectCalendar(connectionId: string): Promise<void> {
  // Fetch the connection first so we can revoke the token
  const { data } = await supabase
    .from('calendar_connections')
    .select('*')
    .eq('id', connectionId)
    .single();

  if (data) {
    await revokeToken(data as CalendarConnection);
  }

  await supabase.from('calendar_connections').delete().eq('id', connectionId);
}

/** Check URL for OAuth callback params and handle them. */
export async function checkOAuthRedirect(userId: string): Promise<CalendarConnection | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const pathMatch = url.pathname.match(/\/auth\/(\w+)\/callback/);

  if (!code || !pathMatch) return null;

  const provider = pathMatch[1];

  // Verify the CSRF state issued by startAuth() matches the value Google
  // echoed back. Mismatch = fabricated callback; drop the code unused.
  const expectedState = sessionStorage.getItem('oauth_state');
  const expectedProvider = sessionStorage.getItem('oauth_provider');
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('oauth_provider');

  // Clean the URL regardless — the code is single-use; never leave it sitting
  // in history/referrers.
  window.history.replaceState({}, '', '/');

  if (!state || !expectedState || state !== expectedState || provider !== expectedProvider) {
    console.error('Calendar: OAuth state mismatch — possible CSRF, ignoring callback');
    return null;
  }

  return handleOAuthCallback(provider, code, userId);
}
