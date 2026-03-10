/** A normalized calendar event from any provider. */
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;   // "HH:MM"
  end: string;      // "HH:MM"
  duration: number; // minutes
  allDay: boolean;
  provider: string; // e.g. "google", "notion"
  sourceCalendar?: string; // calendar name/id from the provider
  color?: string;
}

/** Stored connection record in the DB. */
export interface CalendarConnection {
  id: string;
  user_id: string;
  provider: string;
  provider_account_id: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  calendar_ids: string[]; // which calendars to sync
  display_name: string;
  created_at: string;
}

/** What a provider needs to implement. */
export interface CalendarProvider {
  /** Unique key, e.g. "google", "notion" */
  readonly id: string;
  /** Display name, e.g. "Google Calendar" */
  readonly name: string;
  /** Start the OAuth flow (redirects the user). */
  startAuth(): void;
  /** Fetch events for a given date using a stored connection. */
  fetchEvents(connection: CalendarConnection, date: string): Promise<CalendarEvent[]>;
  /** Refresh an expired access token. Returns the new token + expiry. */
  refreshToken(connection: CalendarConnection): Promise<{ access_token: string; expires_at: string } | null>;
}
