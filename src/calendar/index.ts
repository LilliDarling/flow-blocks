import { supabase } from '../supabase.js';
import type { CalendarConnection, CalendarEvent } from './types.js';
import { registerProvider, getProvider, getAllProviders } from './registry.js';
import { googleProvider, GOOGLE_REDIRECT_URI } from './google.js';
import { isNative } from '../native.js';

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

/** Resolve the redirect URI used when starting OAuth, so we can echo the
 *  same value during the code exchange (Google requires an exact match). */
function redirectUriFor(provider: string): string {
  if (provider === 'google') return GOOGLE_REDIRECT_URI;
  // Fallback shape for any future non-Google provider
  return isNative
    ? `wildbloom://auth/${provider}-callback`
    : `${window.location.origin}/auth/${provider}/callback`;
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
  const redirectUri = redirectUriFor(provider);

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

/** Validate CSRF state and run the exchange. Used by both the web
 *  `checkOAuthRedirect` flow (URL parsed from window.location) and the native
 *  deep-link handler (URL parsed from the appUrlOpen event). */
async function validateAndExchange(
  provider: string, code: string, state: string | null, userId: string,
): Promise<CalendarConnection | null> {
  const expectedState = sessionStorage.getItem('oauth_state');
  const expectedProvider = sessionStorage.getItem('oauth_provider');
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('oauth_provider');

  if (!state || !expectedState || state !== expectedState || provider !== expectedProvider) {
    console.error('Calendar: OAuth state mismatch — possible CSRF, ignoring callback');
    return null;
  }

  return handleOAuthCallback(provider, code, userId);
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

/** Check URL for OAuth callback params and handle them. Web only — the
 *  native deep-link handler routes through `processNativeCallbackUrl` instead. */
export async function checkOAuthRedirect(userId: string): Promise<CalendarConnection | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const pathMatch = url.pathname.match(/\/auth\/(\w+)\/callback/);

  if (!code || !pathMatch) return null;

  const provider = pathMatch[1];

  // Clean the URL regardless of CSRF outcome — the code is single-use;
  // never leave it sitting in history/referrers.
  window.history.replaceState({}, '', '/');

  return validateAndExchange(provider, code, state, userId);
}

/** Handle a native deep-link OAuth callback URL (e.g.
 *  `wildbloom://auth/google-callback?code=…&state=…`). Same CSRF validation
 *  and exchange as the web path; just a different way of getting the URL. */
export async function processNativeCallbackUrl(
  url: string, userId: string,
): Promise<CalendarConnection | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error('Calendar: invalid deep-link URL', url);
    return null;
  }

  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');

  // Match against the raw URL: for custom-scheme URLs the WHATWG URL parser
  // treats `auth` as the host (not part of the path), so `parsed.pathname`
  // is just `/<provider>-callback` — matching `/auth/<provider>-callback`
  // against the parsed path silently fails. The raw URL form is robust to
  // that and matches what the deep-link handler in native.ts already tests.
  const match = url.match(/\/auth\/([\w-]+)-callback/);
  if (!code || !match) return null;
  const provider = match[1];

  return validateAndExchange(provider, code, state, userId);
}
