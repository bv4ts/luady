import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { RefusedError } from '../../src/core/errors.js';
import { sha256Hex } from '../../src/core/ids.js';
import { openMemoryDb } from '../../src/db/open.js';
import { CHALLENGE_TTL_MS, createChallengeStore } from '../../src/web/auth/challenges.js';
import { createPasskeyStore } from '../../src/web/auth/passkeys.js';
import {
  clearSessionCookie,
  createSessionStore,
  csrfMatches,
  rotateSession,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
} from '../../src/web/auth/sessions.js';
import { createFakeClock } from '../helpers/fakes.js';
import { SESSION_SECRET } from './fixtures.js';

const MINUTE = 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CRED = 'Y3JlZGVudGlhbC1vbmU';

function sessionRig() {
  const db = openMemoryDb();
  const clock = createFakeClock();
  return { db, clock, store: createSessionStore({ db, clock }) };
}

function authRig() {
  const db = openMemoryDb();
  const clock = createFakeClock();
  return { db, clock, passkeys: createPasskeyStore({ db, clock }), challenges: createChallengeStore({ db, clock }) };
}

describe('session store', () => {
  it('creates random sid and csrf tokens and stores only the sid hash', () => {
    const { db, store } = sessionRig();
    const a = store.create();
    const b = store.create();
    expect(a.sid).toMatch(TOKEN_RE);
    expect(a.csrf).toMatch(TOKEN_RE);
    expect(a.sid).not.toBe(b.sid);
    const stored = (db.prepare('SELECT sid FROM auth_sessions').all() as Array<{ sid: string }>).map((row) => row.sid);
    expect([...stored].sort()).toEqual([sha256Hex(a.sid), sha256Hex(b.sid)].sort());
    expect(stored).not.toContain(a.sid);
  });

  it('touch refreshes last_seen_at', () => {
    const { clock, store } = sessionRig();
    const session = store.create();
    clock.advance(10 * MINUTE);
    expect(store.touch(session.sid)).toEqual({
      sid: session.sid,
      csrf: session.csrf,
      createdAt: '2026-10-09T12:00:00.000Z',
      lastSeenAt: '2026-10-09T12:10:00.000Z',
    });
  });

  it('expires after one hour without activity and deletes the row', () => {
    const { db, clock, store } = sessionRig();
    const session = store.create();
    clock.advance(SESSION_IDLE_MS);
    expect(store.touch(session.sid)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 });
  });

  it('expires 12 hours after creation even when used every 50 minutes', () => {
    const { clock, store } = sessionRig();
    const session = store.create();
    for (let elapsed = 50 * MINUTE; elapsed < SESSION_ABSOLUTE_MS; elapsed += 50 * MINUTE) {
      clock.advance(50 * MINUTE);
      expect(store.touch(session.sid)).not.toBeNull();
    }
    clock.advance(50 * MINUTE);
    expect(store.touch(session.sid)).toBeNull();
  });

  it('peek validates without extending the idle window', () => {
    const { clock, store } = sessionRig();
    const session = store.create();
    clock.advance(30 * MINUTE);
    expect(store.peek(session.sid)?.lastSeenAt).toBe(session.lastSeenAt);
    clock.advance(30 * MINUTE);
    expect(store.peek(session.sid)).toBeNull();
  });

  it('destroy ends the session and unknown ids are null', () => {
    const { store } = sessionRig();
    const session = store.create();
    store.destroy(session.sid);
    expect(store.touch(session.sid)).toBeNull();
    expect(store.touch('not-a-session')).toBeNull();
  });

  it('purgeExpired removes only expired sessions', () => {
    const { clock, store } = sessionRig();
    const first = store.create();
    clock.advance(30 * MINUTE);
    const second = store.create();
    clock.advance(31 * MINUTE);
    expect(store.purgeExpired()).toBe(1);
    expect(store.peek(first.sid)).toBeNull();
    expect(store.peek(second.sid)).not.toBeNull();
  });

  it('destroyAllExcept revokes every other session and keeps the given one', () => {
    const { store } = sessionRig();
    const keep = store.create();
    const other = store.create();
    const third = store.create();
    expect(store.destroyAllExcept(keep.sid)).toBe(2);
    expect(store.peek(keep.sid)).not.toBeNull();
    expect(store.peek(other.sid)).toBeNull();
    expect(store.peek(third.sid)).toBeNull();
  });
});

describe('csrfMatches', () => {
  it('accepts only the exact token', () => {
    expect(csrfMatches('abc123', 'abc123')).toBe(true);
    expect(csrfMatches('abc123', 'abc124')).toBe(false);
    expect(csrfMatches('abc123', 'abc1234')).toBe(false);
    expect(csrfMatches('abc123', '')).toBe(false);
    expect(csrfMatches('abc123', undefined)).toBe(false);
  });
});

describe('session cookie', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function cookieApp() {
    const { store } = sessionRig();
    const previous = store.create();
    const app = Fastify();
    apps.push(app);
    await app.register(fastifyCookie, { secret: SESSION_SECRET });
    app.post('/login', async (_request, reply) => ({ csrf: rotateSession(store, reply, previous).csrf }));
    app.post('/logout', async (_request, reply) => {
      clearSessionCookie(reply);
      return { ok: true };
    });
    await app.ready();
    return { app, store, previous };
  }

  it('rotateSession issues a signed hub_sid cookie with the required attributes and ends the old session', async () => {
    const { app, store, previous } = await cookieApp();
    const res = await app.inject({ method: 'POST', url: '/login' });
    const header = String(res.headers['set-cookie']);
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=[^;]+\\.[^;]+;`));
    for (const attribute of ['Max-Age=43200', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) {
      expect(header).toContain(attribute);
    }
    expect(store.peek(previous.sid)).toBeNull();
    const signed = decodeURIComponent(header.slice(SESSION_COOKIE.length + 1, header.indexOf(';')));
    const unsigned = app.unsignCookie(signed);
    expect(unsigned.valid).toBe(true);
    if (unsigned.valid) {
      expect(store.peek(unsigned.value)?.csrf).toBe((res.json() as { csrf: string }).csrf);
    }
  });

  it('clearSessionCookie expires the cookie', async () => {
    const { app } = await cookieApp();
    const header = String((await app.inject({ method: 'POST', url: '/logout' })).headers['set-cookie']);
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(header).toContain('Max-Age=0');
  });
});

describe('passkey store', () => {
  it('inserts, counts, lists and gets passkeys', () => {
    const { passkeys } = authRig();
    expect(passkeys.count()).toBe(0);
    const record = passkeys.insert({
      credId: CRED,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ['internal', 'hybrid'],
      label: 'Phone',
    });
    expect(record).toEqual({
      credId: CRED,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ['internal', 'hybrid'],
      label: 'Phone',
      createdAt: '2026-10-09T12:00:00.000Z',
      lastUsedAt: null,
    });
    expect(passkeys.count()).toBe(1);
    expect(passkeys.list()).toEqual([record]);
    expect(passkeys.get(CRED)).toEqual(record);
    expect(passkeys.get('missing')).toBeUndefined();
  });

  it('refuses a duplicate credential id', () => {
    const { passkeys } = authRig();
    const input = { credId: CRED, publicKey: new Uint8Array([1]), counter: 0, transports: [], label: 'Key' };
    passkeys.insert(input);
    expect(() => passkeys.insert(input)).toThrow(RefusedError);
  });

  it('records use with the new counter and timestamp', () => {
    const { clock, passkeys } = authRig();
    passkeys.insert({ credId: CRED, publicKey: new Uint8Array([1]), counter: 3, transports: ['usb'], label: 'Key' });
    clock.advance(5000);
    passkeys.recordUse(CRED, 8);
    expect(passkeys.get(CRED)).toMatchObject({ counter: 8, lastUsedAt: '2026-10-09T12:00:05.000Z' });
  });

  it('remove deletes one passkey and reports unknown ids', () => {
    const { passkeys } = authRig();
    passkeys.insert({ credId: CRED, publicKey: new Uint8Array([1]), counter: 0, transports: [], label: 'Phone' });
    passkeys.insert({ credId: 'Y3JlZC10d28', publicKey: new Uint8Array([2]), counter: 0, transports: [], label: 'Key' });
    expect(passkeys.remove(CRED)).toBe(true);
    expect(passkeys.remove(CRED)).toBe(false);
    expect(passkeys.list().map((passkey) => passkey.credId)).toEqual(['Y3JlZC10d28']);
    expect(passkeys.count()).toBe(1);
  });
});

describe('challenge store', () => {
  it('take returns the purpose exactly once', () => {
    const { challenges } = authRig();
    challenges.save('challenge-aaaaaaaaaaaaaaaa', 'login');
    expect(challenges.take('challenge-aaaaaaaaaaaaaaaa')).toBe('login');
    expect(challenges.take('challenge-aaaaaaaaaaaaaaaa')).toBeNull();
    expect(challenges.take('never-issued-challenge')).toBeNull();
  });

  it('rejects a challenge older than 5 minutes', () => {
    const { clock, challenges } = authRig();
    challenges.save('challenge-bbbbbbbbbbbbbbbb', 'register-setup');
    clock.advance(CHALLENGE_TTL_MS);
    expect(challenges.take('challenge-bbbbbbbbbbbbbbbb')).toBeNull();
  });

  it('purges expired rows when saving', () => {
    const { db, clock, challenges } = authRig();
    challenges.save('challenge-cccccccccccccccc', 'login');
    clock.advance(CHALLENGE_TTL_MS + 1);
    challenges.save('challenge-dddddddddddddddd', 'register');
    expect(db.prepare('SELECT challenge FROM auth_challenges').all()).toEqual([{ challenge: 'challenge-dddddddddddddddd' }]);
  });
});
