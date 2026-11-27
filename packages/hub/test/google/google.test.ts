import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@luady/shared';
import { openMemoryDb } from '../../src/db/open.js';
import { authUrl, meetingLink, sealer } from '../../src/google/api.js';
import { createGoogleService, distinctLabel } from '../../src/google/service.js';
import { createFakeClock, createFakeOutbound, silentLogger } from '../helpers/fakes.js';

const CLIENT = { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret-secret-secret-xx', redirectUri: 'https://luady.example.com/api/google/callback' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('google helpers', () => {
  it('seals refresh tokens so they never sit in the database in clear', () => {
    const box = sealer('x'.repeat(64));
    const sealed = box.seal('1//refresh-token');
    expect(sealed).not.toContain('refresh');
    expect(box.open(sealed)).toBe('1//refresh-token');
    expect(() => sealer('y'.repeat(64)).open(sealed)).toThrow();
  });

  it('asks for offline read-only access and finds meeting links', () => {
    const url = new URL(authUrl(CLIENT, 'st'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toContain('gmail.readonly');
    expect(url.searchParams.get('scope')).not.toContain('gmail.modify');
    expect(meetingLink({ id: 'a', hangoutLink: 'https://meet.google.com/abc' })).toBe('https://meet.google.com/abc');
    expect(meetingLink({ id: 'b', description: 'Join: https://us02web.zoom.us/j/123?pwd=x thanks' })).toBe('https://us02web.zoom.us/j/123?pwd=x');
    expect(meetingLink({ id: 'c', location: 'Office' })).toBeNull();
  });
});

describe('google service', () => {
  it('connects with a single-use state, primes without alerting, then alerts new important mail and reminds meetings', async () => {
    const clock = createFakeClock('2026-10-10T08:00:00.000Z');
    const outbound = createFakeOutbound();
    let inbox = [{ id: 'm1' }];
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        const idToken = `h.${Buffer.from(JSON.stringify({ email: 'Alex@Example.com' })).toString('base64url')}.s`;
        return json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt', id_token: idToken });
      }
      if (url.includes('/messages?')) return json({ messages: inbox });
      if (url.includes('/messages/')) {
        const id = url.split('/messages/')[1]?.split('?')[0];
        return json({
          id, snippet: 'Please review the contract', labelIds: ['IMPORTANT'],
          payload: { headers: [{ name: 'From', value: '"Sara K" <sara@client.com>' }, { name: 'Subject', value: `Contract ${id}` }] },
        });
      }
      if (url.includes('/calendar/v3/')) {
        return json({
          items: [{
            id: 'ev1', summary: 'Client call', start: { dateTime: '2026-10-10T08:10:00.000Z' }, end: { dateTime: '2026-10-10T08:40:00.000Z' },
            hangoutLink: 'https://meet.google.com/xyz',
          }],
        });
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const settings = { ...DEFAULT_SETTINGS, quiet_hours: { start: '00:00', end: '00:00', tz: 'Etc/GMT-4' as const } };
    const google = createGoogleService({
      db: openMemoryDb(), clock, log: silentLogger(), outbound, settings: { get: () => settings, update: vi.fn() },
      client: CLIENT, secret: 's'.repeat(64),
    });
    const code = google.issueLink('work');
    expect(google.consumeLink(code)).toBe('work');
    expect(google.consumeLink(code)).toBeNull();
    const state = new URL(google.connectUrl('work')).searchParams.get('state') ?? '';
    await expect(google.finish(state, 'code')).resolves.toEqual({ email: 'alex@example.com', label: 'work' });
    await expect(google.finish(state, 'code')).rejects.toThrow(/expired/);

    await google.tick();
    expect(outbound.sent.map((m) => m.text)).toEqual(['📅 *In 10 min* · 12:10 PM · work\n*Client call*\n🔗 https://meet.google.com/xyz']);
    inbox = [{ id: 'm1' }, { id: 'm2' }];
    await google.tick();
    expect(outbound.sent).toHaveLength(2);
    expect(outbound.sent[1]?.text).toBe('📧 *Sara K* · work\n*Contract m2*\n_Please review the contract_');
  });

  it('calendar reminders leave through their own send-now channel, mail through the ordinary one', async () => {
    const clock = createFakeClock('2026-10-10T08:00:00.000Z');
    const outbound = createFakeOutbound();
    const reminders = createFakeOutbound();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        const idToken = `h.${Buffer.from(JSON.stringify({ email: 'me@example.com' })).toString('base64url')}.s`;
        return json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt', id_token: idToken });
      }
      if (url.includes('/messages?')) return json({ messages: [] });
      if (url.includes('/calendar/v3/')) {
        return json({ items: [{ id: 'ev2', summary: 'Standup', start: { dateTime: '2026-10-10T08:12:00.000Z' }, end: { dateTime: '2026-10-10T08:30:00.000Z' } }] });
      }
      return json({}, 404);
    }));
    const google = createGoogleService({
      db: openMemoryDb(), clock, log: silentLogger(), outbound, reminders, settings: { get: () => DEFAULT_SETTINGS, update: vi.fn() },
      client: CLIENT, secret: 's'.repeat(64),
    });
    const state = new URL(google.connectUrl('work')).searchParams.get('state') ?? '';
    await google.finish(state, 'code');
    await google.tick();
    expect(reminders.sent.map((m) => m.text)).toEqual(['📅 *In 12 min* · 12:12 PM · work\n*Standup*']);
    expect(outbound.sent).toEqual([]);
  });

  it('never lets two accounts share a label', () => {
    const existing = [{ email: 'me@gmail.com', label: 'personal' }, { email: 'a@orchard.example', label: 'work' }];
    expect(distinctLabel('work', 'a@harbor.example', existing)).toBe('harbor');
    expect(distinctLabel('work', 'a@orchard.example', existing)).toBe('work');
    expect(distinctLabel('personal', 'x@gmail.com', existing)).toBe('personal-3');
  });
});
