import { htmlToText, tidyMailBody } from '../mail/mail-text.js';

export interface GoogleClient { clientId: string; clientSecret: string; redirectUri: string }

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TIMEOUT_MS = 20_000;

export function authUrl(client: GoogleClient, state: string): string {
  const params = new URLSearchParams({
    client_id: client.clientId, redirect_uri: client.redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function form(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Google token request failed (${response.status}): ${String(data.error_description ?? data.error ?? '')}`);
  return data;
}

/** Code → refresh token + the account's email (from the ID token Google just returned over TLS). */
export async function exchangeCode(client: GoogleClient, code: string): Promise<{ refreshToken: string; email: string }> {
  const data = await form(TOKEN_URL, {
    code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: client.redirectUri, grant_type: 'authorization_code',
  });
  const refreshToken = data.refresh_token;
  const idToken = data.id_token;
  if (typeof refreshToken !== 'string' || typeof idToken !== 'string') throw new Error('Google returned no refresh token; remove Luady from the account and connect again');
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown };
  if (typeof payload.email !== 'string') throw new Error('Google returned no email for the account');
  return { refreshToken, email: payload.email.toLowerCase() };
}

export async function accessToken(client: GoogleClient, refreshToken: string): Promise<{ token: string; expiresAt: number }> {
  const data = await form(TOKEN_URL, {
    refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'refresh_token',
  });
  if (typeof data.access_token !== 'string') throw new Error('Google returned no access token');
  return { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in ?? 3600) - 60) * 1000 };
}

async function get<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Google API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as T;
}

export interface MailSummary { id: string; from: string; subject: string; date: string; snippet: string; labels: string[] }

interface GmailMessage {
  id: string;
  snippet?: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name: string; value: string }>; mimeType?: string; body?: { data?: string }; parts?: GmailMessage['payload'][] };
}

const header = (message: GmailMessage, name: string): string =>
  message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

export async function searchMail(token: string, query: string, max: number): Promise<MailSummary[]> {
  const list = await get<{ messages?: Array<{ id: string }> }>(`${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`, token);
  const ids = (list.messages ?? []).map((m) => m.id);
  return Promise.all(ids.map(async (id) => {
    const m = await get<GmailMessage>(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, token);
    return { id, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: (m.snippet ?? '').trim(), labels: m.labelIds ?? [] };
  }));
}

function plainText(part: GmailMessage['payload']): string {
  if (part === undefined) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const child of part.parts ?? []) {
    const text = plainText(child);
    if (text !== '') return text;
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return htmlToText(Buffer.from(part.body.data, 'base64url').toString('utf8'));
  }
  return '';
}

export async function readMail(token: string, id: string): Promise<{ from: string; subject: string; date: string; body: string }> {
  const m = await get<GmailMessage>(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, token);
  return { from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'), body: tidyMailBody(plainText(m.payload)) };
}

export interface CalendarEvent { id: string; title: string; start: string; end: string; allDay: boolean; link: string | null; location: string }

interface GEvent {
  id: string; status?: string; summary?: string; location?: string; description?: string; hangoutLink?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
}

/** The video link of an event: Meet, then any conference entry point, then a Zoom/Teams/Meet URL in location or description. */
export function meetingLink(event: GEvent): string | null {
  if (event.hangoutLink) return event.hangoutLink;
  const video = event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
  if (video) return video;
  const text = `${event.location ?? ''} ${event.description ?? ''}`;
  return /https:\/\/[^\s"<>]*(zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com)[^\s"<>]*/i.exec(text)?.[0] ?? null;
}

export async function listEvents(token: string, fromIso: string, toIso: string): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({ timeMin: fromIso, timeMax: toIso, singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
  const data = await get<{ items?: GEvent[] }>(`${CALENDAR}?${params}`, token);
  return (data.items ?? [])
    .filter((e) => e.status !== 'cancelled' && e.attendees?.find((a) => a.self)?.responseStatus !== 'declined')
    .map((e) => ({
      id: e.id, title: e.summary ?? '(no title)', start: e.start?.dateTime ?? e.start?.date ?? '', end: e.end?.dateTime ?? e.end?.date ?? '',
      allDay: e.start?.dateTime === undefined, link: meetingLink(e), location: e.location ?? '',
    }));
}

/** The token sealer lives in core/seal.ts; Google, Wispr and Jira tokens all use it. */
export { sealer } from '../core/seal.js';
