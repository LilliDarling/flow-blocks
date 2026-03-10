import type { CalendarProvider, CalendarConnection, CalendarEvent } from './types.js';
import { supabase } from '../supabase.js';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const REDIRECT_URI = `${window.location.origin}/auth/google/callback`;

export const googleProvider: CalendarProvider = {
  id: 'google',
  name: 'Google Calendar',

  startAuth(): void {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email',
      access_type: 'offline',
      prompt: 'select_account consent',
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
        });
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        if (!res.ok) continue;
        const data = await res.json();

        for (const item of data.items || []) {
          if (item.status === 'cancelled') continue;

          const allDay = !!item.start?.date;
          const startDt = allDay ? null : new Date(item.start.dateTime);
          const endDt = allDay ? null : new Date(item.end.dateTime);

          allEvents.push({
            id: `google_${item.id}`,
            title: item.summary || '(No title)',
            start: startDt ? `${pad(startDt.getHours())}:${pad(startDt.getMinutes())}` : '00:00',
            end: endDt ? `${pad(endDt.getHours())}:${pad(endDt.getMinutes())}` : '23:59',
            duration: startDt && endDt ? Math.round((endDt.getTime() - startDt.getTime()) / 60000) : 1440,
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

    // Try edge function first, fall back to direct refresh
    try {
      const { data, error } = await supabase.functions.invoke('calendar-token-refresh', {
        body: {
          provider: 'google',
          connection_id: connection.id,
          refresh_token: connection.refresh_token,
        },
      });

      if (!error && data?.access_token) {
        return { access_token: data.access_token, expires_at: data.expires_at };
      }
    } catch {
      // Edge function unavailable, try direct refresh
    }

    // Direct refresh fallback (requires VITE_GOOGLE_CLIENT_SECRET)
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
    const clientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET || '';
    if (!clientSecret) {
      console.error('Calendar: No VITE_GOOGLE_CLIENT_SECRET set and edge function unavailable');
      return null;
    }

    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: connection.refresh_token,
          grant_type: 'refresh_token',
        }),
      });

      if (!res.ok) {
        console.error('Calendar: Token refresh failed', await res.text());
        return null;
      }

      const data = await res.json();
      const expiresIn = (data.expires_in as number) || 3600;
      const expires_at = new Date(Date.now() + expiresIn * 1000).toISOString();

      // Update the connection in the DB with new tokens
      await supabase
        .from('calendar_connections')
        .update({
          access_token: data.access_token,
          token_expires_at: expires_at,
        })
        .eq('id', connection.id);

      return { access_token: data.access_token, expires_at };
    } catch {
      return null;
    }
  },
};

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
