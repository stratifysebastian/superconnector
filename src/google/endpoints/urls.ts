/**
 * The only place under src/ that may name Google API hosts and paths (enforced by tests/contract).
 * Adapters build URLs with these helpers; GoogleHttp then checks every request against ENDPOINT_RULES.
 */

export const GOOGLE_API_HOSTS: readonly string[] = [
  'www.googleapis.com',
  'gmail.googleapis.com',
  'docs.googleapis.com',
  'sheets.googleapis.com',
  'slides.googleapis.com',
];

function join(base: string, path: string): string {
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** `path` is relative to the API root, e.g. gmailUrl('/users/me/drafts'). No query string: pass `query` to GoogleHttp. */
export const gmailUrl = (path: string): string => join('https://gmail.googleapis.com/gmail/v1', path);
export const calendarUrl = (path: string): string => join('https://www.googleapis.com/calendar/v3', path);
export const driveUrl = (path: string): string => join('https://www.googleapis.com/drive/v3', path);
export const driveUploadUrl = (path: string): string => join('https://www.googleapis.com/upload/drive/v3', path);
export const docsUrl = (path: string): string => join('https://docs.googleapis.com/v1', path);
export const sheetsUrl = (path: string): string => join('https://sheets.googleapis.com/v4/spreadsheets', path);
export const slidesUrl = (path: string): string => join('https://slides.googleapis.com/v1/presentations', path);
