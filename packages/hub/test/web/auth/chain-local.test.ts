import { describe, expect, it } from 'vitest';
import { PAGE_KEY_HEADER } from '@luady/shared';
import { createLocalIdentity } from '../../../src/web/auth/access.js';
import { isSessionExempt } from '../../../src/web/auth/chain.js';
import { SESSION_COOKIE, createSessionStore, type SessionStore } from '../../../src/web/auth/sessions.js';
import { passkeyUserName } from '../../../src/web/auth/webauthn.js';
import { call, harnessFactory, testConfig, makeDirs } from '../helpers.js';

const harness = harnessFactory();

/** A local-mode hub: no Access verifier in front, the owner label as the identity, the page key on. */
async function localHub(ownerLabel = 'Sam') {
  let store: SessionStore | null = null;
  // Local mode: no Access e-mail and no Access fields at all.
  const { ownerEmail: _email, cfTeamDomain: _team, cfAccessAud: _aud, ...base } = testConfig(makeDirs());
  const config = { ...base, authMode: 'local' as const, ownerLabel };
  const h = await harness({
    config, access: createLocalIdentity(ownerLabel),
    pageKey: { required: () => true, matches: (sid, key) => store?.pageKeyMatches(sid, key) ?? false },
  });
  store = createSessionStore({ db: h.deps.db, clock: h.clock });
  const made = store.create();
  const session = { sid: made.sid, csrf: made.csrf, cookie: `${SESSION_COOKIE}=${encodeURIComponent(h.app.signCookie(made.sid))}` };
  return { h, session, pageKey: made.pageKey };
}

describe('the auth chain in local mode', () => {
  it('needs no Access token: the session and its page key are the gate, and the owner label is the identity', async () => {
    const { h, session, pageKey } = await localHub('Sam');
    const me = await call(h, 'GET', '/api/me', undefined, { session, token: null, headers: { [PAGE_KEY_HEADER]: pageKey } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ owner: 'Sam', authMode: 'local', csrf: session.csrf });
  });

  it('without a session it still answers 401, and a static page needs nothing', async () => {
    const { h } = await localHub();
    expect((await call(h, 'GET', '/api/overview', undefined, { token: null })).statusCode).toBe(401);
    expect((await call(h, 'GET', '/', undefined, { token: null })).statusCode).toBe(200);
  });

  it('keeps the Origin and CSRF rules on every mutating request', async () => {
    const { h, session, pageKey } = await localHub();
    const key = { [PAGE_KEY_HEADER]: pageKey };
    const foreign = await call(h, 'POST', '/api/auth/logout', {}, { session, token: null, origin: 'https://evil.example', headers: key });
    expect(foreign.statusCode).toBe(403);
    const noCsrf = await call(h, 'POST', '/api/sessions', { server: 'cedar', cwd: '/home/dev/projects/x' }, { session, token: null, csrf: null, headers: key });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('exempts the setup state and the login link from the session (and from the page key)', () => {
    expect(isSessionExempt('/api/setup/state')).toBe(true);
    expect(isSessionExempt('/api/setup/login')).toBe(true);
    expect(isSessionExempt('/api/setup/step')).toBe(false);
    expect(isSessionExempt('/api/setup/finish')).toBe(false);
  });

  it('a passkey made in local mode (no e-mail) is named after the owner label, never an empty name', () => {
    expect(passkeyUserName({ ownerLabel: 'Sam' })).toBe('Sam');
    expect(passkeyUserName({ ownerLabel: undefined })).toBe('owner');
    expect(passkeyUserName({ ownerEmail: 'owner@example.com', ownerLabel: 'Sam' })).toBe('owner@example.com');
  });

  it('createLocalIdentity refuses an empty label rather than run with none', () => {
    expect(() => createLocalIdentity('  ')).toThrow(/owner label/);
  });
});
