import type { CalendarProvider, CalendarConnection, CalendarEvent } from './types.js';
import { supabase } from '../supabase.js';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const REDIRECT_URI = `${window.location.origin}/auth/google/callback`;

export const googleProvider: CalendarProvider = {
  id: 'google',
  name: 'Google Calendar',

  startAuth(): void {
    // CSRF protection: random state stored in sessionStorage, echoed by Google,
    // verified on callback. Without this, an attacker could feed a victim a
    // crafted /auth/google/callback?code=… link to attach an attacker-owned
    // Google account to the victim's session.
    const state = crypto.randomUUID();
    sessionStorage.setItem('oauth_state', state);
    sessionStorage.setItem('oauth_provider', 'google');

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email',
      access_type: 'offline',
      prompt: 'select_account consent',
      state,
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },

  async fetchEvents(connection: CalendarConnection, date: string): Promise<CalendarEvent[]> {
    // Check if token is expired and refresh if needed
    let { access_token } = connection;
    if (connection.token_expires_at && new Date(connection.token_expires_at) <= new Date()) {
      const refreshed = await this.refreshToken(connection);
      if (refreshed) {
        access_token = refreshed.access_token;
      } else {
        return []; // Token refresh failed
      }
    }

    const calendarIds = connection.calendar_ids.length > 0
      ? connection.calendar_ids
      : ['primary'];

    // Build RFC3339 timestamps in the user's local timezone
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T23:59:59`);
    const timeMin = dayStart.toISOString();
    const timeMax = dayEnd.toISOString();
    const allEvents: CalendarEvent[] = [];

    for (const calId of calendarIds) {
      try {
        const params = new URLSearchParams({
          timeMin,
          timeMax,
          timeZone: tz,
          singleEvents: 'true',
          orderBy: 'startTime',
          // Hard per-calendar ceiling. 50 events in a single day is already
          // extreme; capping here keeps a recurring-meetings-gone-wild
          // calendar from swamping the grid.
          maxResults: '50',
        });
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        if (!res.ok) continue;
        const data = await res.json();

        for (const item of data.items || []) {
          if (item.status === 'cancelled') continue;

          // Skip non-commitment event types — out-of-office markers,
          // working-location indicators, etc. aren't things the user is
          // "doing" at that time.
          if (item.eventType === 'outOfOffice' || item.eventType === 'workingLocation') continue;

          // Skip events the user explicitly marked as available ("Show me as:
          // Free"). These are reminders/placeholders, not commitments.
          if (item.transparency === 'transparent') continue;

          // Skip events the user hasn't accepted (declined or not yet
          // responded). Tentative responses stay — the user might accept.
          if (item.attendees) {
            const self = item.attendees.find((a: { self?: boolean }) => a.self);
            if (self && (self.responseStatus === 'declined' || self.responseStatus === 'needsAction')) continue;
          }

          const allDay = !!item.start?.date;
          const startDt = allDay ? null : new Date(item.start.dateTime);
          const endDt = allDay ? null : new Date(item.end.dateTime);
          const durationMin = startDt && endDt
            ? Math.round((endDt.getTime() - startDt.getTime()) / 60000)
            : 1440;

          // Skip runaway multi-day timed events (e.g. a 72-hour "conference"
          // block). They mangle the day grid and rarely represent a single
          // commitment. All-day events still pass through the `allDay` flag.
          if (!allDay && durationMin > 24 * 60) continue;

          allEvents.push({
            id: `google_${item.id}`,
            title: item.summary || '(No title)',
            start: startDt ? `${pad(startDt.getHours())}:${pad(startDt.getMinutes())}` : '00:00',
            end: endDt ? `${pad(endDt.getHours())}:${pad(endDt.getMinutes())}` : '23:59',
            duration: durationMin,
            allDay,
            provider: 'google',
            sourceCalendar: calId,
          });
        }
      } catch {
        // Silently skip failed calendars
      }
    }

    return allEvents;
  },

  async refreshToken(connection: CalendarConnection): Promise<{ access_token: string; expires_at: string } | null> {
    if (!connection.refresh_token) return null;

    // Token refresh goes through edge function only — client secret AND
    // refresh_token stay server-side; the function looks the refresh token up
    // by connection_id after verifying the caller owns the connection.
    try {
      const { data, error } = await supabase.functions.invoke('calendar-token-refresh', {
        body: {
          provider: 'google',
          connection_id: connection.id,
        },
      });

      if (!error && data?.access_token) {
        return { access_token: data.access_token, expires_at: data.expires_at };
      }

      console.error('Calendar: Token refresh failed', error);
      connection._needsReconnect = true;
      return null;
    } catch (err) {
      console.error('Calendar: Token refresh unavailable', err);
      return null;
    }
  },
};

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
