/**
 * Calendar adapter contract (Phase 1). Adapters return Google Calendar API resources nearly verbatim,
 * because the built-in connector does (docs/builtin-tools/calendar.json). Tools add account tags.
 */

export interface GDateTime {
  dateTime?: string; // RFC3339 with offset
  date?: string; // all-day
  timeZone?: string;
}

export interface GAttendee {
  email: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  displayName?: string;
  optional?: boolean;
}

/** A Calendar API Event. Unknown fields pass through untouched. */
export interface GEvent {
  id: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  start?: GDateTime;
  end?: GDateTime;
  updated?: string;
  attendees?: GAttendee[];
  organizer?: { email?: string; self?: boolean };
  [k: string]: unknown;
}

export interface GCalendarListEntry {
  id: string;
  summary?: string;
  description?: string;
  timeZone?: string;
  primary?: boolean;
  [k: string]: unknown;
}

/**
 * The only event fields a write may send. There is deliberately no attendee, guest-permission or
 * notification field: the type itself cannot carry an invitation.
 */
export interface EventWriteBody {
  summary?: string;
  description?: string;
  location?: string;
  start?: GDateTime;
  end?: GDateTime;
  recurrence?: string[];
  colorId?: string;
  visibility?: string;
  transparency?: 'opaque' | 'transparent';
  eventType?: string;
  reminders?: { useDefault?: boolean; overrides?: { method: string; minutes: number }[] };
  conferenceData?: unknown; // Meet link creation only
  attachments?: { fileUrl: string; title?: string }[];
  workingLocationProperties?: unknown;
}

export interface Page<T> {
  items: T[];
  nextPageToken?: string;
}

export interface CalendarAdapter {
  listCalendars(p: { pageSize: number; pageToken?: string }): Promise<Page<GCalendarListEntry>>;
  listEvents(p: {
    calendarId: string;
    pageSize: number;
    pageToken?: string;
    timeMin?: string;
    timeMax?: string;
    q?: string;
    orderBy?: 'startTime' | 'updated';
    eventTypes?: string[];
    timeZone?: string;
  }): Promise<Page<GEvent>>;
  /** Null when the event does not exist on this account. */
  getEvent(p: { calendarId: string; eventId: string }): Promise<GEvent | null>;
  /** Busy intervals per requested calendar id / email. */
  freeBusy(p: { timeMin: string; timeMax: string; timeZone?: string; ids: string[] }): Promise<
    Record<string, { busy: { start: string; end: string }[]; errors?: unknown[] }>
  >;
  /** Always sent with sendUpdates=none and conferenceDataVersion=1 when conferenceData is set. */
  insertEvent(p: { calendarId: string; body: EventWriteBody }): Promise<GEvent>;
  /** Always sent with sendUpdates=none. */
  patchEvent(p: { calendarId: string; eventId: string; body: EventWriteBody }): Promise<GEvent>;
}
