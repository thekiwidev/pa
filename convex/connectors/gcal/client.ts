// A thin Google Calendar client. No SDK — the googleapis package would force
// "use node" (512 MB against a 20 GB-hour budget) to call three JSON
// endpoints. Same call gmail/client.ts makes, for the same reason.
//
// The access token is ALWAYS argument one. Nothing in this file reads an
// environment variable or decrypts anything; it is handed a token by an
// action that already resolved which account is being acted on.

const BASE = "https://www.googleapis.com/calendar/v3";

export class CalendarApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`calendar ${status}: ${body.slice(0, 300)}`);
    this.name = "CalendarApiError";
  }
  /** The token is fine but this scope was never granted. */
  get isScopeFailure() {
    return this.status === 403;
  }
}

async function calendarFetch<T>(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    // Every outbound call is inside a user-facing turn. A hung request is
    // worse than a failed one: the user is watching a typing indicator.
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new CalendarApiError(res.status, await res.text());
  return (await res.json()) as T;
}

/**
 * Google returns a date-time for a timed event and a bare date for an
 * all-day one. They are genuinely different things — an all-day event has
 * no time to render and no timezone to render it in — so the distinction is
 * kept rather than flattened into a fake midnight.
 */
export interface CalendarWhen {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  /** Google Meet link, when the event has one. */
  hangoutLink?: string;
  status?: string;
  start: CalendarWhen;
  end: CalendarWhen;
  attendees?: { email: string; displayName?: string; responseStatus?: string; self?: boolean }[];
  organizer?: { email?: string; self?: boolean };
  creator?: { email?: string; self?: boolean };
  recurringEventId?: string;
}

/**
 * Pure. The query string for a time-bounded event listing.
 *
 * `singleEvents: true` is not optional. Without it a weekly standup comes
 * back once, as a recurrence RULE, and "what's my day" silently omits every
 * repeating meeting — which is most of them. It also makes `orderBy:
 * startTime` legal, which Google rejects otherwise.
 */
export function buildListEventsQuery(options: {
  timeMinIso: string;
  timeMaxIso: string;
  limit?: number;
  query?: string;
}): string {
  const params = new URLSearchParams({
    timeMin: options.timeMinIso,
    timeMax: options.timeMaxIso,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(options.limit ?? 25, 100)),
  });
  if (options.query) params.set("q", options.query);
  return params.toString();
}

export async function listEvents(
  accessToken: string,
  options: { timeMinIso: string; timeMaxIso: string; limit?: number; query?: string; calendarId?: string },
): Promise<CalendarEvent[]> {
  const calendarId = encodeURIComponent(options.calendarId ?? "primary");
  const data = await calendarFetch<{ items?: CalendarEvent[] }>(
    accessToken,
    `/calendars/${calendarId}/events?${buildListEventsQuery(options)}`,
  );
  // A cancelled instance of a recurring event still comes back, with
  // status:"cancelled" and usually no summary. Showing it as a meeting is
  // worse than not showing it at all.
  return (data.items ?? []).filter((e) => e.status !== "cancelled");
}

export async function getEvent(
  accessToken: string,
  eventId: string,
  calendarId = "primary",
): Promise<CalendarEvent | null> {
  try {
    return await calendarFetch<CalendarEvent>(
      accessToken,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
  } catch (error) {
    if (error instanceof CalendarApiError && error.status === 404) return null;
    throw error;
  }
}

export interface CalendarEventCreate {
  summary: string;
  description?: string;
  location?: string;
  /** RFC3339 with offset, e.g. 2026-09-08T10:00:00+01:00. */
  startIso: string;
  endIso: string;
  timeZone: string;
  attendeeEmails?: string[];
}

/** Pure. The request body, kept separate so a test can assert on it. */
export function buildCreateEventBody(event: CalendarEventCreate): Record<string, unknown> {
  return {
    summary: event.summary,
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    start: { dateTime: event.startIso, timeZone: event.timeZone },
    end: { dateTime: event.endIso, timeZone: event.timeZone },
    ...(event.attendeeEmails?.length
      ? { attendees: event.attendeeEmails.map((email) => ({ email })) }
      : {}),
  };
}

export async function createEvent(
  accessToken: string,
  event: CalendarEventCreate,
  calendarId = "primary",
): Promise<CalendarEvent> {
  // sendUpdates=all when there are attendees: an invitation nobody receives
  // is not an invitation. With no attendees the parameter is meaningless, and
  // passing it anyway would be a claim that mail was sent.
  const notify = event.attendeeEmails?.length ? "?sendUpdates=all" : "";
  return await calendarFetch<CalendarEvent>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events${notify}`,
    { method: "POST", body: buildCreateEventBody(event) },
  );
}

export interface CalendarListEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
}

export async function listCalendars(accessToken: string): Promise<CalendarListEntry[]> {
  const data = await calendarFetch<{ items?: CalendarListEntry[] }>(
    accessToken,
    "/users/me/calendarList?maxResults=50",
  );
  return data.items ?? [];
}
