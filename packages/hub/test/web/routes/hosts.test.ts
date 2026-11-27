import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { HOST_GRANT_HEADER, HostCheckDTOSchema, HostRemoveResultDTOSchema, PAGE_KEY_HEADER } from '@luady/shared';
import type { Logger } from '../../../src/core/contracts.js';
import { SESSION_COOKIE, createSessionStore, type SessionStore } from '../../../src/web/auth/sessions.js';
import { FP_SCANNED, PIN, hostsRig, settle, type Rig } from '../../hosts/rig.js';
import { call, harnessFactory, type Harness, type LoggedIn } from '../helpers.js';

const harness = harnessFactory();

interface Signed extends LoggedIn {
  readonly pageKey: string;
}

interface Bench {
  readonly h: Harness;
  readonly rig: Rig;
  readonly logs: string[];
  readonly bodies: Array<{ readonly url: string; readonly text: string }>;
  session(): Signed;
  /** A call with the session's page key (and the grant, when given); every answer is kept for the scrubber. */
  send(method: 'GET' | 'POST' | 'PUT', url: string, body?: object, opts?: { session?: Signed; grant?: string; key?: string | null }): Promise<{ status: number; json: Record<string, unknown> }>;
}

/** A logger that keeps every line, at every level, for the scrubber. */
function capture(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  return { log: pino({ level: 'trace' }, sink), lines };
}

async function bench(): Promise<Bench> {
  const { log, lines } = capture();
  const rig = hostsRig({ log });
  let store: SessionStore | null = null;
  const h = await harness({
    hosts: rig.hosts, log,
    pageKey: { required: () => true, matches: (sid, key) => store?.pageKeyMatches(sid, key) ?? false },
  });
  const own = createSessionStore({ db: h.deps.db, clock: h.clock });
  store = own;
  const bodies: Array<{ url: string; text: string }> = [];
  let fallback: Signed | null = null;
  const session = (): Signed => {
    const made = own.create();
    return { sid: made.sid, csrf: made.csrf, pageKey: made.pageKey, cookie: `${SESSION_COOKIE}=${encodeURIComponent(h.app.signCookie(made.sid))}` };
  };
  return {
    h, rig, logs: lines, bodies, session,
    async send(method, url, body, opts = {}) {
      fallback ??= session();
      const who = opts.session ?? fallback;
      const key = opts.key === undefined ? who.pageKey : opts.key;
      const headers = { ...(key === null ? {} : { [PAGE_KEY_HEADER]: key }), ...(opts.grant === undefined ? {} : { [HOST_GRANT_HEADER]: opts.grant }) };
      const res = await call(h, method, url, body, { session: who, headers });
      bodies.push({ url: `${method} ${url}`, text: `${JSON.stringify(res.headers)}\n${res.body}` });
      return { status: res.statusCode, json: res.body === '' ? {} : (res.json() as Record<string, unknown>) };
    },
  };
}

const MARS = { id: 'mars', host: 'mars.example.com', user: 'dev', port: 22 };

/** Creates mars and walks it to a pinned, online host; returns its grant. */
async function pinnedMars(b: Bench, session?: Signed): Promise<string> {
  const created = await b.send('POST', '/api/hosts', { ...MARS, pin: PIN }, { ...(session === undefined ? {} : { session }) });
  expect(created.status).toBe(200);
  const grant = created.json.grant as string;
  expect((await b.send('POST', '/api/hosts/mars/scan', {}, { grant, ...(session === undefined ? {} : { session }) })).status).toBe(200);
  expect((await b.send('POST', '/api/hosts/mars/pin', { fingerprint: FP_SCANNED }, { grant, ...(session === undefined ? {} : { session }) })).status).toBe(200);
  b.rig.links.get('mars')?.setStatus('online');
  return grant;
}

describe('the hosts routes', () => {
  it('without the page key every hosts route answers 401', async () => {
    const b = await bench();
    for (const [method, url] of [['GET', '/api/hosts'], ['GET', '/api/hosts/key'], ['POST', '/api/hosts'], ['POST', '/api/hosts/mars/scan'],
      ['POST', '/api/hosts/mars/remove'], ['PUT', '/api/hosts/mars']] as const) {
      expect((await b.send(method, url, method === 'GET' ? undefined : { pin: PIN }, { key: null })).status, `${method} ${url}`).toBe(401);
    }
  });

  it('every change without its PIN or its grant answers 403, and nothing changes', async () => {
    const b = await bench();
    const pinRoutes = [['POST', '/api/hosts', MARS], ['POST', '/api/hosts/local', { projectsRoot: '~/projects' }], ['POST', '/api/hosts/mars/grant', {}],
      ['PUT', '/api/hosts/mars', { port: 2222 }], ['POST', '/api/hosts/mars/remove', { uninstallKit: true, removeKey: true, rooms: 'keep' }]] as const;
    for (const [method, url, body] of pinRoutes) {
      const res = await b.send(method, url, body);
      expect(res.status, url).toBe(403);
      expect(res.json, url).toMatchObject({ error: { code: 'pin_required' } });
    }
    await b.send('POST', '/api/hosts', { ...MARS, pin: PIN });
    for (const [url, body] of [['/api/hosts/mars/scan', {}], ['/api/hosts/mars/pin', { fingerprint: FP_SCANNED }], ['/api/hosts/mars/check', {}],
      ['/api/hosts/mars/kit', { mode: 'install' }]] as const) {
      const res = await b.send('POST', url, body);
      expect(res.status, url).toBe(403);
      expect(res.json, url).toMatchObject({ error: { code: 'grant_required' } });
      expect((await b.send('POST', url, body, { grant: 'x'.repeat(43) })).status, url).toBe(403);
    }
    expect(b.rig.scans).toEqual([]);
    expect(b.rig.hosts.get('mars')?.state).toBe('draft');
    const wrong = await b.send('POST', '/api/hosts', { ...MARS, id: 'venus', pin: '000000' });
    expect(wrong.status).toBe(403);
    expect(wrong.json).toMatchObject({ error: { code: 'pin_invalid', remaining: 4 } });
  });

  it('a grant serves only its own session and host', async () => {
    const b = await bench();
    const mine = b.session();
    const other = b.session();
    const created = await b.send('POST', '/api/hosts', { ...MARS, pin: PIN }, { session: mine });
    await b.send('POST', '/api/hosts', { ...MARS, id: 'venus', pin: PIN }, { session: mine });
    const grant = created.json.grant as string;
    expect((await b.send('POST', '/api/hosts/mars/scan', {}, { session: other, grant })).status).toBe(403);
    expect((await b.send('POST', '/api/hosts/venus/scan', {}, { session: mine, grant })).status).toBe(403);
    expect((await b.send('POST', '/api/hosts/mars/scan', {}, { session: mine, grant })).status).toBe(200);
    const again = await b.send('POST', '/api/hosts/mars/grant', { pin: PIN }, { session: other });
    expect(again.status).toBe(200);
    expect((await b.send('POST', '/api/hosts/mars/scan', {}, { session: other, grant: again.json.grant as string })).status).toBe(200);
  });

  it('walks the whole flow: key, create, scan, pin, check, kit (202), job, edit, remove', async () => {
    const b = await bench();
    const key = await b.send('GET', '/api/hosts/key');
    expect(key.json.line).toBe(`no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 ${b.rig.fleetKey.blob} luady-fleet`);
    expect(key.json.publicKey).toBe(b.rig.fleetKey.publicKey);
    const grant = await pinnedMars(b);
    const check = await b.send('POST', '/api/hosts/mars/check', {}, { grant });
    expect(check).toMatchObject({ status: 200, json: { auth: 'ok', missing: [] } });
    expect(HostCheckDTOSchema.safeParse(check.json).success).toBe(true);
    const kit = await b.send('POST', '/api/hosts/mars/kit', { mode: 'install' }, { grant });
    expect(kit.status).toBe(202);
    expect(kit.json).toMatchObject({ state: 'running' });
    await settle();
    const job = await b.send('GET', '/api/hosts/mars/job');
    expect(job.json).toMatchObject({ job: kit.json.job, state: 'done' });
    expect((await b.send('GET', '/api/hosts/venus/job')).status).toBe(404);
    const list = await b.send('GET', '/api/hosts');
    // The check filled in mars's folders, so the kit job rebuilt its link from the row: it is connecting again.
    expect(list.json).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'mars', state: 'pinned', projectsRoot: '/home/dev/projects' })]));
    expect((await b.send('PUT', '/api/hosts/mars', { projectsRoot: '/srv/work', pin: PIN })).json).toMatchObject({ projectsRoot: '/srv/work' });
    b.rig.links.get('mars')?.setStatus('online');
    const removed = await b.send('POST', '/api/hosts/mars/remove', { uninstallKit: true, removeKey: true, rooms: 'delete', pin: PIN });
    expect(removed.json).toMatchObject({ host: 'mars', steps: { kit: 'done', key: 'done', record: 'removed', rooms: 'deleted' } });
    expect(HostRemoveResultDTOSchema.safeParse(removed.json).success).toBe(true);
    expect((await b.send('POST', '/api/hosts', { ...MARS, pin: PIN })).json).toMatchObject({ error: { code: 'host_exists' } });
  });

  it('refuses hostile bodies with 400 and a refused address with address_refused', async () => {
    const b = await bench();
    for (const host of ['a;rm -rf /', '$(id)', '-oProxyCommand=x']) {
      expect((await b.send('POST', '/api/hosts', { ...MARS, host, pin: PIN })).status, host).toBe(400);
    }
    expect((await b.send('POST', '/api/hosts', { ...MARS, host: '169.254.169.254', pin: PIN })).json).toMatchObject({ error: { code: 'address_refused' } });
    expect((await b.send('POST', '/api/hosts', { ...MARS, id: 'computer', pin: PIN })).status).toBe(400);
    expect((await b.send('POST', '/api/hosts', { ...MARS, pin: PIN, command: 'id' })).status).toBe(400);
  });

  it('requests without the grant never use up a host\'s scans and checks (the grant is checked first)', async () => {
    const b = await bench();
    const grant = (await b.send('POST', '/api/hosts', { ...MARS, pin: PIN })).json.grant as string;
    for (let i = 0; i < 8; i += 1) expect((await b.send('POST', '/api/hosts/mars/scan', {})).status).toBe(403);
    const scans = [];
    for (let i = 0; i < 7; i += 1) scans.push((await b.send('POST', '/api/hosts/mars/scan', {}, { grant })).status);
    expect(scans).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });

  it('rate limits: 20 changes a minute per client, 6 scans or checks a minute per host', async () => {
    const b = await bench();
    const grant = (await b.send('POST', '/api/hosts', { ...MARS, pin: PIN })).json.grant as string;
    const scans = [];
    for (let i = 0; i < 7; i += 1) scans.push((await b.send('POST', '/api/hosts/mars/scan', {}, { grant })).status);
    expect(scans).toEqual([200, 200, 200, 200, 200, 200, 429]);
    const changes = [];
    for (let i = 0; i < 13; i += 1) changes.push((await b.send('POST', '/api/hosts', { ...MARS, id: `site-${i}`, pin: PIN })).status);
    // 1 create + 7 scans + 12 creates = 20; the 13th create is the 21st change.
    expect(changes.slice(0, 12).every((status) => status === 200)).toBe(true);
    expect(changes[12]).toBe(429);
    b.rig.clock.advance(60_001);
    expect((await b.send('POST', '/api/hosts', { ...MARS, id: 'site-late', pin: PIN })).status).toBe(200);
  });

  it('the scrubber: no PIN, grant, page key or key material in any answer or log line', async () => {
    const b = await bench();
    const signed = b.session();
    const grant = await pinnedMars(b, signed);
    await b.send('POST', '/api/hosts/mars/check', {}, { session: signed, grant });
    await b.send('POST', '/api/hosts/mars/kit', { mode: 'install' }, { session: signed, grant });
    await settle();
    await b.send('GET', '/api/hosts', undefined, { session: signed });
    await b.send('GET', '/api/hosts/key', undefined, { session: signed });
    await b.send('POST', '/api/hosts/mars/grant', { pin: PIN }, { session: signed });
    await b.send('POST', '/api/hosts/mars/remove', { uninstallKit: true, removeKey: true, rooms: 'keep', pin: PIN }, { session: signed });
    const privateKey = readFileSync(b.rig.fleetKey.path, 'utf8');
    const privateLines = privateKey.split('\n').filter((line) => line.length > 20 && !line.startsWith('-----'));
    const answers = b.bodies.map((body) => body.text).join('\n');
    // A grant is handed out only by the routes that issue one (after the PIN); no other answer carries it.
    const issuing = /^POST \/api\/hosts(?:\/local|\/[a-z0-9-]+\/grant)?$/;
    const others = b.bodies.filter((body) => !issuing.test(body.url)).map((body) => body.text).join('\n');
    const logs = b.logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [PIN, signed.pageKey, signed.sid, ...privateLines]) {
      expect(answers.includes(secret), `an answer holds a secret (${secret.slice(0, 4)}…)`).toBe(false);
      expect(logs.includes(secret), `a log line holds a secret (${secret.slice(0, 4)}…)`).toBe(false);
    }
    expect(answers.includes(grant)).toBe(true);
    expect(others.includes(grant)).toBe(false);
    expect(logs.includes(grant)).toBe(false);
    expect(logs).not.toContain(b.rig.fleetKey.blob);
    expect(logs).not.toMatch(/PRIVATE KEY/);
    expect(answers).not.toMatch(/PRIVATE KEY/);
  });
});
