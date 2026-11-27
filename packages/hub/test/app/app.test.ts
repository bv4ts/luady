import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {} from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityListDTOSchema, OverviewDTOSchema, PAGE_KEY_HEADER, type NoticeDTO, type SpoolEvent, type ActivitySpoolEvent } from '@luady/shared';
import { createApp, type App } from '../../src/app.js';
import { systemClock } from '../../src/core/clock.js';
import type { AccessVerifier, Db, Fleet, HubConfig } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import type { TmuxRunner } from '../../src/luady/service.js';
import { helpText } from '../../src/notify/format.js';
import { SESSION_COOKIE, createSessionStore } from '../../src/web/auth/sessions.js';
import { markSetUp } from '../../test/helpers/claimed.js';
import { createFakeCtl, silentLogger, classicHostLookups } from '../../test/helpers/fakes.js';
import { TEST_CHAT_ID, openTestChat, testChatDecl, type ChatAddon } from '../helpers/chat-addon.js';
import { loadedDefaults } from '../helpers/loaded-config.js';
import { createFakeFleet, serverDto, type FakeFleet, type FakeTail } from '../fleet/fake-fleet.js';
import { meters, notification, pausedEvent, prompt, sessionStart, stop, subagent, toolEnd, toolStart } from '../sessions/spool-events.js';
import { connectWs, sleep } from '../web/ws-helpers.js';

const TOKEN = 'd'.repeat(64);

/** `withChat`: the test chat add-on is declared (tests that talk to the owner through a chat). */
function testConfig(withChat = false): HubConfig {
  const root = mkdtempSync(join(tmpdir(), 'luady-app-'));
  const webDir = join(root, 'web');
  mkdirSync(webDir);
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Luady</title>');
  return {
    ...loadedDefaults(join(root, 'data')),
    servers: [], fleetKeyPath: join(root, 'fleet_key'), dataDir: join(root, 'data'), brainDir: '/home/luady/brain',
    runDir: join(root, 'run'), webDir, webPort: 7410, publicOrigin: 'https://luady.example.com',
    rpId: 'luady.example.com', ownerPhone: '447700900001', ownerEmail: 'owner@example.com',
    cfTeamDomain: 'team.cloudflareaccess.com', cfAccessAud: 'aud-tag', sessionSecret: 'e'.repeat(64), hubSocketToken: TOKEN,
    claudePath: '/home/luady/.local/bin/claude', localCtlPath: '/home/luady/.luady/bin/luady-ctl', remoteCtlPath: '~/.luady/bin/luady-ctl',
    ...(withChat ? { addons: [testChatDecl('447700900001')] } : {}),
  };
}

function fakeFleet(): Fleet {
  const ctl = createFakeCtl();
  return {
    start: async () => undefined,
    stop: async () => undefined,
    client: () => ctl,
    servers: () => [],
    openShell: async () => {
      throw new Error('no shell in tests');
    },
    ...classicHostLookups(), tailEvents: () => {
      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { stop: () => finish(), done };
    },
  };
}

const aliveTmux: TmuxRunner = {
  run: async (args) => ({ code: 0, stdout: args[0] === 'display-message' ? 'claude\n' : '', stderr: '' }),
};
const ownerAccess: AccessVerifier = { verify: async () => ({ email: 'owner@example.com' }) };
/** The hub answers its own Host only (421 otherwise), and /api needs the session's page key. */
const HUB_HOST = 'luady.example.com';
const hub = (pageKey: string): Record<string, string> => ({ host: HUB_HOST, [PAGE_KEY_HEADER]: pageKey });
/** An existing install keeps its manager on (016); a new one starts with it off. */
const managerOn = (db: Db): void => {
  db.prepare("INSERT INTO settings (key, value_json) VALUES ('manager_enabled', 'true')").run();
};
/** A website tab: the hub's Host on the upgrade, then the page key as the first message. */
async function website(base: string, headers: Record<string, string>, pageKey: string) {
  const probe = await connectWs(`${base.replace(/^http/, 'ws')}/ws`, { ...headers, host: HUB_HOST });
  probe.ws.send(JSON.stringify({ type: 'auth', key: pageKey }));
  return probe;
}

let app: App | null = null;

afterEach(async () => {
  await app?.stop();
  app = null;
});

async function startedApp(withChat = false) {
  const config = testConfig(withChat);
  const db = openMemoryDb();
  await markSetUp(db);
  managerOn(db);
  const created = await createApp(config, {
    db, log: silentLogger(), access: ownerAccess, tmux: aliveTmux, fleet: fakeFleet(),
  });
  app = created;
  await created.start({ listen: false });
  return { config, db, app: created };
}

describe('createApp', () => {
  it('serves /api/overview to an authenticated owner session and the internal health check', async () => {
    const t = await startedApp();
    const session = createSessionStore({ db: t.db, clock: systemClock }).create();
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(t.app.web.signCookie(session.sid))}`;
    const overview = await t.app.web.inject({
      method: 'GET', url: '/api/overview', headers: { 'cf-access-jwt-assertion': 'test-jwt', cookie, ...hub(session.pageKey) },
    });
    expect(overview.statusCode).toBe(200);
    expect(OverviewDTOSchema.safeParse(overview.json()).success).toBe(true);
    const health = await t.app.internal.inject({
      method: 'GET', url: '/internal/health', headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(health.json()).toEqual({ ok: true });
  });

  it('routes owner chat messages through the inbound router', async () => {
    const t = await startedApp(true);
    const socket = await openTestChat(t.app, t.config.dataDir);
    socket.receive({ t: 'incoming', msgId: 'in-1', from: '447700900001', text: '/help', ts: 1_791_547_200 });
    await vi.waitFor(() => expect(socket.frames.map((f) => f.text)).toContain(helpText()));
    const reply = socket.frames.find((f) => f.text === helpText());
    expect(reply?.replyTo).toBe('in-1');
    socket.receive({ t: 'sent', ref: reply?.ref, msgId: 'wamid.HELP', error: null });
  });

  it('the start-up retention sweep deletes notices settled over 30 days ago and expires open ones that old', async () => {
    const config = testConfig();
    const db = openMemoryDb();
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
    const recent = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const insert = db.prepare('INSERT INTO notices (id, kind, text, created_at, settled_at, settled_via) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('settled-old', 'result', 'a', old, old, 'web');
    insert.run('settled-new', 'result', 'b', recent, recent, 'web');
    insert.run('open-old', 'result', 'c', old, null, null);
    app = await createApp(config, { db, log: silentLogger(), access: ownerAccess, tmux: aliveTmux, fleet: fakeFleet() });
    await app.start({ listen: false });
    const rows = db.prepare('SELECT id, settled_via FROM notices ORDER BY id').all();
    expect(rows).toEqual([{ id: 'open-old', settled_via: 'expired' }, { id: 'settled-new', settled_via: 'web' }]);
  });

  it('starts and stops idempotently', async () => {
    const t = await startedApp();
    await t.app.start({ listen: false });
    await t.app.stop();
    await t.app.stop();
    app = null;
  });
});

const SID = 'cedar:cc-meadow-hr:0.0';
const FILE = 'events-20261114.jsonl';

function kit2Fleet(): { fleet: FakeFleet; ctl: ReturnType<typeof createFakeCtl> } {
  const ctl = createFakeCtl();
  const fleet = createFakeFleet({ cedar: ctl });
  fleet.setServers([{ ...serverDto('cedar'), kitVersion: '2.0.0' }]);
  return { fleet, ctl };
}

async function appWith(fleet: FakeFleet, withChat = false) {
  const config = testConfig(withChat);
  const db = openMemoryDb();
  await markSetUp(db);
  managerOn(db);
  const created = await createApp(config, { db, log: silentLogger(), access: ownerAccess, tmux: aliveTmux, fleet });
  app = created;
  await created.start({ listen: false });
  const tail = fleet.tails.find((item) => item.host === 'cedar');
  if (tail === undefined) throw new Error('no cedar tail');
  let offset = 0;
  const emit = (event: SpoolEvent | ActivitySpoolEvent): void => {
    offset += 100;
    (tail as FakeTail).emit(JSON.stringify({ file: FILE, offset, event }));
  };
  const session = createSessionStore({ db, clock: systemClock }).create();
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(created.web.signCookie(session.sid))}`;
  return { config, db, app: created, emit, cookie, csrf: session.csrf, pageKey: session.pageKey };
}

const now = (): string => new Date().toISOString();
const count = (ctl: ReturnType<typeof createFakeCtl>, method: string): number => ctl.calls.filter((call) => call.method === method).length;

describe('activity in the app', () => {
  it('a step reaches GET /api/activity and nothing else: no events row, no session write, no session.updated, no spool.event, no transcript fetch', async () => {
    const { fleet, ctl } = kit2Fleet();
    const t = await appWith(fleet);
    t.emit(sessionStart('startup', { ts: now() }));
    const row = (): unknown => t.db.prepare('SELECT last_event_at, state FROM sessions WHERE id = ?').get(SID);
    const before = row();
    expect(before).toMatchObject({ state: 'idle' });
    const base = await t.app.web.listen({ host: '127.0.0.1', port: 0 });
    const probe = await website(base, { 'cf-access-jwt-assertion': 'test-jwt', origin: t.config.publicOrigin, cookie: t.cookie }, t.pageKey);
    await probe.next();
    probe.ws.send(JSON.stringify({ type: 'subscribe.transcript', sessionId: SID }));
    await vi.waitFor(() => expect(count(ctl, 'transcript')).toBeGreaterThanOrEqual(1));
    await sleep(700);
    const fetches = count(ctl, 'transcript');
    const seen: string[] = [];
    t.app.services.bus.on('session.updated', (session) => seen.push(`session.updated ${session.id}`));
    t.app.services.bus.on('spool.event', ({ event }) => seen.push(`spool.event ${event.event}`));

    t.emit(toolStart('Bash', 'npm test', { ts: now(), toolUseId: 'toolu_app_1' }));

    const res = await t.app.web.inject({ method: 'GET', url: '/api/activity', headers: { 'cf-access-jwt-assertion': 'test-jwt', cookie: t.cookie, ...hub(t.pageKey) } });
    expect(res.statusCode).toBe(200);
    expect(ActivityListDTOSchema.parse(res.json()).items).toEqual([expect.objectContaining({ sessionId: SID, tool: 'run' })]);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'tool_start'").get()).toEqual({ n: 0 });
    expect(row()).toEqual(before);
    await sleep(700);
    expect(seen).toEqual([]);
    expect(count(ctl, 'transcript')).toBe(fetches);

    t.emit(prompt('go on', { ts: now() }));
    await vi.waitFor(() => expect(count(ctl, 'transcript')).toBeGreaterThan(fetches));
    expect(seen).toContain(`session.updated ${SID}`);
    probe.ws.close();
  });

  it('a session the owner paused refuses a send with session_paused and nothing is typed', async () => {
    const { fleet, ctl } = kit2Fleet();
    const t = await appWith(fleet);
    t.emit(sessionStart('startup', { ts: now() }));
    await t.app.services.pauses.pause(SID);
    expect(ctl.calls.filter((call) => call.method === 'pause')).toEqual([{ method: 'pause', args: ['cc-meadow-hr:0.0'] }]);
    await expect(t.app.services.sessions.send(SID, 'x', 'web')).rejects.toMatchObject({ code: 'session_paused' });
    expect(count(ctl, 'send')).toBe(0);
    expect(t.app.services.activity.snapshot()).toEqual([expect.objectContaining({ sessionId: SID, paused: true })]);
  });

  it('right after a restart a send to a session whose kit flag is set is refused, before any reconciliation', async () => {
    const ctl = createFakeCtl({
      sessions: async () => ({
        sessions: [{
          target: 'cc-meadow-hr:0.0', tmux_session: 'cc-meadow-hr', pane_pid: 1, command: 'claude', cwd: '/home/dev/projects/meadow-hr',
          is_claude: true, session_id: 'claude-a', transcript_path: null, registered: true, pending_qid: null, paused: true,
        }],
      }),
    });
    const fleet = createFakeFleet({ cedar: ctl });
    fleet.setServers([{ ...serverDto('cedar'), kitVersion: '2.0.0' }]);
    const t = await appWith(fleet);
    t.emit(sessionStart('startup', { ts: now() }));
    await expect(t.app.services.sessions.send(SID, 'x', 'web')).rejects.toMatchObject({ code: 'session_paused' });
    expect(count(ctl, 'send')).toBe(0);
    expect(t.app.services.pauses.isPaused(SID)).toBe(true);
  });

  it('a Stop is held after the pause hit, but is a real end of turn once a later step shows the session running again', async () => {
    const ctl = createFakeCtl({ resume: async () => ({ ok: true, was_hit: false, sent: false }) });
    const fleet = createFakeFleet({ cedar: ctl });
    fleet.setServers([{ ...serverDto('cedar'), kitVersion: '2.0.0' }]);
    const t = await appWith(fleet);
    const finished: string[] = [];
    t.app.services.bus.on('turn.finished', (event) => finished.push(event.lastMessage));
    const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
    t.emit(sessionStart('startup', { ts: at(0) }));
    t.emit(prompt('go', { ts: at(1) }));
    await t.app.services.pauses.pause(SID);
    t.emit(pausedEvent({ ts: at(2) }));
    expect(t.app.services.pauses.isHeld(SID)).toBe(true);
    t.emit(stop('held stop', { ts: at(3) }));
    expect(finished).toEqual([]);
    t.emit(toolStart('Bash', 'npm test', { ts: at(4), toolUseId: 'after-hit' }));
    expect(t.app.services.pauses.isHeld(SID)).toBe(false);
    expect(t.app.services.pauses.isPaused(SID)).toBe(true);
    t.emit(prompt('go on', { ts: at(5) }));
    t.emit(stop('real stop', { ts: at(6) }));
    expect(finished).toEqual(['real stop']);
    await t.app.services.pauses.resume(SID);
    expect(finished).toEqual(['real stop']);
  });

  it('after stop() the activity service leaves no timer behind', async () => {
    const { fleet } = kit2Fleet();
    const t = await appWith(fleet);
    const updates: unknown[] = [];
    t.app.services.bus.on('activity.updated', ({ items }) => updates.push(items));
    t.emit(sessionStart('startup', { ts: now() }));
    t.emit(sessionStart('startup', { ts: now(), tmux: 'cc-api:0.0', session_id: 'claude-b' }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      t.emit(toolStart('Bash', 'npm test', { ts: now(), toolUseId: 'a' }));
      t.emit(toolStart('Read', 'held until the second is over', { ts: now(), toolUseId: 'b', tmux: 'cc-api:0.0' }));
      expect(updates).toHaveLength(1);
      await t.app.stop();
      app = null;
      vi.advanceTimersByTime(10_000);
      expect(updates).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});


const NEVER_QUIET = { start: '00:00', end: '00:00', tz: 'Etc/GMT-4' } as const;

/** The test chat add-on, connected and up, so sends leave at once. */
function openChat(t: { app: App; config: HubConfig }): Promise<ChatAddon> {
  return openTestChat(t.app, t.config.dataDir);
}

const sends = (socket: ChatAddon): unknown[] => socket.frames.filter((f) => f.t === 'send').map((f) => f.text);

describe('owner-facing sends in the app', () => {
  it('with no website client a usage notice goes to the chat at once', async () => {
    const { fleet } = kit2Fleet();
    const t = await appWith(fleet, true);
    t.app.services.settings.update({ quiet_hours: NEVER_QUIET });
    const wa = await openChat(t);
    t.emit(sessionStart('startup', { ts: now() }));
    t.emit(notification('error', 'Claude usage limit reached', { ts: now() }));
    await vi.waitFor(() => expect(sends(wa)).toEqual([expect.stringContaining('usage limit reached')]));
    wa.receive({ t: 'sent', ref: wa.frames.find((f) => f.t === 'send')?.ref, msgId: 'wamid.USAGE', error: null });
    await vi.waitFor(() => expect(t.app.services.notices.list()).toEqual([expect.objectContaining({ kind: 'alert', settledVia: TEST_CHAT_ID })]));
  });

  it('with a visible website client the usage notice stays on the website: a notice, no chat frame', async () => {
    const { fleet } = kit2Fleet();
    const t = await appWith(fleet, true);
    t.app.services.settings.update({ quiet_hours: NEVER_QUIET });
    const wa = await openChat(t);
    const base = await t.app.web.listen({ host: '127.0.0.1', port: 0 });
    const probe = await website(base, { 'cf-access-jwt-assertion': 'test-jwt', origin: t.config.publicOrigin, cookie: t.cookie }, t.pageKey);
    await probe.next();
    probe.ws.send(JSON.stringify({ type: 'presence.hello', visible: true }));
    probe.ws.send(JSON.stringify({ type: 'presence.active' }));
    await probe.until('presence.updated');
    const created: NoticeDTO[] = [];
    t.app.services.bus.on('notice.created', (notice) => created.push(notice));
    t.emit(sessionStart('startup', { ts: now() }));
    t.emit(notification('error', 'Claude usage limit reached', { ts: now() }));
    await vi.waitFor(() => expect(created).toEqual([expect.objectContaining({ kind: 'alert', settledAt: null })]));
    expect(created[0]?.chatDueAt).not.toBeNull();
    const forwarded = await probe.until('notice.created');
    expect(forwarded.at(-1)).toMatchObject({ type: 'notice.created', notice: { id: created[0]?.id } });
    await sleep(100);
    expect(sends(wa)).toEqual([]);
    probe.ws.close();
  });

  it('activity never sends a chat message or makes a notice, even with the website off', async () => {
    const { fleet } = kit2Fleet();
    const t = await appWith(fleet, true);
    t.app.services.settings.update({ quiet_hours: NEVER_QUIET });
    const wa = await openChat(t);
    const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
    t.emit(sessionStart('startup', { ts: at(0) }));
    t.emit(prompt('go', { ts: at(1) }));
    const framesBefore = sends(wa).length;
    for (let i = 0; i < 30; i += 1) {
      t.emit(toolStart('Bash', `npm test ${i}`, { ts: at(10 + i), toolUseId: `burst-${i}` }));
      t.emit(toolEnd('Bash', `npm test ${i}`, { ts: at(10 + i), toolUseId: `burst-${i}`, ok: i % 7 !== 0 }));
    }
    t.emit(toolEnd('TodoWrite', '2 items', { ts: at(50), todos: [{ id: null, subject: 'a', status: 'completed' }, { id: null, subject: 'b', status: 'pending' }] }));
    t.emit(subagent('start', 'agent-1', { ts: at(51) }));
    t.emit(subagent('stop', 'agent-1', { ts: at(52) }));
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    t.emit(meters({ context_pct: 96, five_hour: { used_pct: 97, resets_at: soon }, seven_day: { used_pct: 91, resets_at: soon } }, { ts: at(53) }));
    t.emit(meters({ context_pct: 99, five_hour: null, seven_day: null }, { ts: at(54), tmux: null }));
    await t.app.services.pauses.pause(SID);
    t.emit(pausedEvent({ ts: at(55) }));
    await t.app.services.pauses.resume(SID);
    await sleep(1_300);
    expect(sends(wa).length).toBe(framesBefore);
    expect(t.app.services.notices.list()).toEqual([]);
    // Control: in this same setup an owner-facing notice does reach the chat at once.
    t.emit(notification('error', 'Claude usage limit reached', { ts: at(60) }));
    await vi.waitFor(() => expect(sends(wa).length).toBe(framesBefore + 1));
  });

  it("during the morning brief turn Luady's notify_user is the morning message: the chat at once, even with the website on", async () => {
    const { fleet } = kit2Fleet();
    const t = await appWith(fleet, true);
    t.app.services.settings.update({ quiet_hours: NEVER_QUIET });
    const wa = await openChat(t);
    const base = await t.app.web.listen({ host: '127.0.0.1', port: 0 });
    const probe = await website(base, { 'cf-access-jwt-assertion': 'test-jwt', origin: t.config.publicOrigin, cookie: t.cookie }, t.pageKey);
    await probe.next();
    probe.ws.send(JSON.stringify({ type: 'presence.hello', visible: true }));
    probe.ws.send(JSON.stringify({ type: 'presence.active' }));
    await probe.until('presence.updated');
    const brain = fleet.tails.find((tail) => tail.host === 'hq');
    let offset = 0;
    const toBrain = (event: SpoolEvent): void => {
      offset += 100;
      brain?.emit(JSON.stringify({ file: FILE, offset, event }));
    };
    const onBrain = { tmux: 'manager:0.0', session_id: 'luady-claude', cwd: '/home/luady/brain' };
    const notify = async (text: string): Promise<unknown> => (await t.app.internal.inject({
      method: 'POST', url: '/internal/tools/notify_user', headers: { authorization: `Bearer ${TOKEN}` }, payload: { text },
    })).json();
    toBrain(prompt('[Scheduled · Sat 08:00] Morning brief for 2026-11-14: read brief/2026-11-14.md and send the owner a short brief', { ...onBrain, ts: now() }));
    const morning = notify('Good morning! Two meetings today.');
    await vi.waitFor(() => expect(sends(wa)).toEqual([expect.stringContaining('Good morning! Two meetings today.')]));
    wa.receive({ t: 'sent', ref: wa.frames.find((f) => f.t === 'send')?.ref, msgId: 'wamid.MORNING', error: null });
    expect(await morning).toMatchObject({ ok: true });
    expect(t.app.services.notices.list().map((notice) => notice.kind)).toContain('morning');
    toBrain(stop('Brief sent.', { ...onBrain, ts: now() }));
    toBrain(prompt('[Scheduled · Sat 09:00] Check the build', { ...onBrain, ts: now() }));
    expect(await notify('The build is green.')).toMatchObject({ ok: true });
    await sleep(150);
    expect(sends(wa)).toHaveLength(1);
    expect(t.app.services.notices.list()).toContainEqual(expect.objectContaining({ kind: 'result', text: 'The build is green.', chatSentAt: null }));
    probe.ws.close();
  });

  it('an old-website tab (pings only, never hello) leaves the flag unset: a usage notice still goes to the chat at once', async () => {
    const { fleet } = kit2Fleet();
    const t = await appWith(fleet, true);
    t.app.services.settings.update({ quiet_hours: NEVER_QUIET });
    const wa = await openChat(t);
    const base = await t.app.web.listen({ host: '127.0.0.1', port: 0 });
    const probe = await website(base, { 'cf-access-jwt-assertion': 'test-jwt', origin: t.config.publicOrigin, cookie: t.cookie }, t.pageKey);
    await probe.next();
    probe.ws.send(JSON.stringify({ type: 'ping' }));
    await probe.next();
    const chat = await t.app.web.inject({
      method: 'POST', url: '/api/manager/messages', payload: { text: 'hello from the old website' },
      headers: { 'cf-access-jwt-assertion': 'test-jwt', cookie: t.cookie, origin: t.config.publicOrigin, 'x-hub-csrf': t.csrf, ...hub(t.pageKey) },
    });
    expect(chat.statusCode).toBe(200);
    expect(t.app.services.presence.capable()).toBe(false);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'notices.website_first'").get()).toEqual({ n: 0 });
    t.emit(sessionStart('startup', { ts: now() }));
    t.emit(notification('error', 'Claude usage limit reached', { ts: now() }));
    await vi.waitFor(() => expect(sends(wa)).toEqual([expect.stringContaining('usage limit reached')]));
    probe.ws.close();
  });

  it('a sign-in code or a PIN the owner sends never becomes a notice', async () => {
    const t = await startedApp(true);
    const wa = await openChat(t);
    const code = `${'A'.repeat(32)}#${'B'.repeat(32)}`;
    wa.receive({ t: 'incoming', msgId: 'in-1', from: '447700900001', text: code, ts: 1_791_547_200 });
    wa.receive({ t: 'incoming', msgId: 'in-2', from: '447700900001', text: '482916', ts: 1_791_547_201 });
    await vi.waitFor(() => expect(sends(wa)).toHaveLength(2));
    const texts = t.db.prepare<[], { text: string }>('SELECT text FROM notices').all().map((row) => row.text);
    expect(texts.filter((text) => text.includes('AAAAAAAA') || text.includes('482916'))).toEqual([]);
  });
});
