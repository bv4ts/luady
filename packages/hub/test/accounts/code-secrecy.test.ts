import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_KEY_HEADER, type HostId } from '@luady/shared';
import { createApp, type App } from '../../src/app.js';
import { systemClock } from '../../src/core/clock.js';
import type { CtlClient, Db, Fleet, HubConfig } from '../../src/core/contracts.js';
import { CtlError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import type { TmuxRunner } from '../../src/luady/service.js';
import { SESSION_COOKIE, createSessionStore } from '../../src/web/auth/sessions.js';
import { createCaptureLogger } from '../security/capture-logger.js';
import { createFakeCtl, classicHostLookups } from '../helpers/fakes.js';
import { openTestChat, testChatDecl } from '../helpers/chat-addon.js';
import { loadedDefaults } from '../helpers/loaded-config.js';

// Every code the kit is handed in this test; none may come back out anywhere but the kit's stdin.
const RIGHT = `${'R'.repeat(40)}#${'s'.repeat(40)}`;
const ECHOED = `${'E'.repeat(40)}#${'t'.repeat(40)}`;
const BROKEN = `${'B'.repeat(40)}#${'u'.repeat(40)}`;
const PASTED = `${'P'.repeat(40)}#${'v'.repeat(40)}`;
const IN_A_SENTENCE = `${'S'.repeat(40)}#${'w'.repeat(40)}`;
const CODES = [RIGHT, ECHOED, BROKEN, PASTED, IN_A_SENTENCE];
const SECRETS = [...CODES, ...CODES.flatMap((code) => code.split('#')), 'state=s1'];
const URL = 'https://claude.com/cai/oauth/authorize?code=true&state=s1';
const OWNER = '447700900001';

function config(): HubConfig {
  const root = mkdtempSync(join(tmpdir(), 'luady-codes-'));
  const webDir = join(root, 'web');
  mkdirSync(webDir);
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Luady</title>');
  return {
    ...loadedDefaults(join(root, 'data')),
    servers: [], fleetKeyPath: join(root, 'fleet_key'), dataDir: join(root, 'data'), brainDir: '/home/luady/brain',
    runDir: join(root, 'run'), webDir, webPort: 7410, publicOrigin: 'https://luady.example.invalid', rpId: 'luady.example.invalid',
    ownerPhone: OWNER, ownerEmail: 'owner@example.invalid', cfTeamDomain: 'team.cloudflareaccess.com', cfAccessAud: 'aud',
    sessionSecret: 'e'.repeat(64), hubSocketToken: 'd'.repeat(64), claudePath: '/home/luady/.local/bin/claude',
    localCtlPath: '/home/luady/.luady/bin/luady-ctl', remoteCtlPath: '~/.luady/bin/luady-ctl',
    addons: [testChatDecl(OWNER)],
  };
}

/** The kit echoes the code back, in its message and in an error, as a careless CLI might. */
const authCode: CtlClient['authCode'] = async (code) => {
  if (code === BROKEN) throw new CtlError('failed', `luady-ctl auth-code exited with 1: could not use ${code}`, 1);
  if (code === RIGHT || code === PASTED) return { ok: true, message: 'Login successful', logged_in: true, email: 'o@x', expires_at: null };
  return { ok: false, message: `OAuth error: invalid code ${code}`, logged_in: false, email: null, expires_at: null };
};

function fleet(): Fleet & { brain: () => string[] } {
  const clients = new Map<HostId, ReturnType<typeof createFakeCtl>>();
  const client = (host: HostId): ReturnType<typeof createFakeCtl> => {
    const found = clients.get(host) ?? createFakeCtl({ authLogin: async () => ({ url: URL }), authCode });
    clients.set(host, found);
    return found;
  };
  return {
    /** Everything really typed into the brain (luady-ctl send on the luady host). */
    brain: () => client('hq').calls.filter((c) => c.method === 'send').map((c) => String(c.args[1])),
    start: async () => undefined, stop: async () => undefined, client, servers: () => [],
    openShell: async () => {
      throw new Error('no shell');
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

/** Every row of every table, as text. */
function everyRow(db: Db): string {
  const tables = db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%'").all();
  return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join('\n');
}

let app: App | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

describe('a sign-in code never leaves the kit stdin', () => {
  it('not in a log line, the database (actions, notices, messages, queue), an answer, a chat reply or the brain', { timeout: 30_000 }, async () => {
    const capture = createCaptureLogger();
    const db = openMemoryDb();
    // An existing install keeps its manager on (016); a new one starts with it off.
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('manager_enabled', 'true')").run();
    const tmuxCalls: string[][] = [];
    const tmux: TmuxRunner = {
      run: async (args) => {
        tmuxCalls.push([...args]);
        return { code: 0, stdout: args[0] === 'display-message' ? 'claude\n' : '', stderr: '' };
      },
    };
    const cfg = config();
    const hubFleet = fleet();
    app = await createApp(cfg, { db, log: capture.log, access: { verify: async () => ({ email: cfg.ownerEmail }) }, tmux, fleet: hubFleet });
    await app.start({ listen: false });
    // A sign-in on a host not known to be signed out needs the PIN; with confirmations off it runs at once.
    app.services.settings.update({ require_pin: false });
    // Changing an account on the website always needs the PIN, whatever require_pin says.
    await app.services.pin.set('135790', { setupCode: app.services.setupCodes.issue('owner_setup') });
    const session = createSessionStore({ db, clock: systemClock }).create();
    const headers = {
      'cf-access-jwt-assertion': 'jwt', cookie: `${SESSION_COOKIE}=${encodeURIComponent(app.web.signCookie(session.sid))}`,
      origin: cfg.publicOrigin, 'x-hub-csrf': session.csrf,
      // The hub's own Host (421 otherwise) and the session's page key on every /api call.
      host: 'luady.example.invalid', [PAGE_KEY_HEADER]: session.pageKey,
    };
    const post = (url: string, payload: object) => app!.web.inject({ method: 'POST', url, headers, payload });
    const answers: string[] = [];

    expect((await post('/api/accounts/cedar/login', {})).statusCode).toBe(428);
    expect((await post('/api/accounts/cedar/login', { pin: '135790' })).statusCode).toBe(200);
    for (const code of [ECHOED, BROKEN, RIGHT]) {
      const res = await post('/api/accounts/cedar/code', { code });
      expect(res.statusCode).toBe(200);
      answers.push(res.body);
    }
    expect(JSON.parse(answers[2] ?? '{}')).toMatchObject({ ok: true });

    // The chat add-on, which acknowledges every message as a real chat does once its chat took it.
    const wa = await openTestChat(app, cfg.dataDir, { autoAck: true });
    wa.receive({ t: 'incoming', msgId: 'in-1', from: OWNER, text: '/login birch', ts: 1_791_547_200 });
    await vi.waitFor(() => expect(wa.frames.filter((f) => f.t === 'send')).toHaveLength(2));
    wa.receive({ t: 'incoming', msgId: 'in-2', from: OWNER, text: ECHOED, ts: 1_791_547_201 });
    // One code per sign-in at a time: the next one is pasted after the answer to the first.
    await vi.waitFor(() => expect(wa.frames.filter((f) => f.t === 'send')).toHaveLength(3));
    wa.receive({ t: 'incoming', msgId: 'in-3', from: OWNER, text: PASTED, ts: 1_791_547_202 });
    await vi.waitFor(() => expect(wa.frames.filter((f) => f.t === 'send')).toHaveLength(4));
    expect(String(wa.frames.filter((f) => f.t === 'send').at(-1)?.text)).toContain('birch is signed in');

    // While a sign-in waits, a code inside a sentence goes to it, never to the brain; a plain message does reach the brain.
    wa.receive({ t: 'incoming', msgId: 'in-4', from: OWNER, text: '/login ash', ts: 1_791_547_203 });
    await vi.waitFor(() => expect(wa.frames.filter((f) => f.t === 'send')).toHaveLength(6));
    wa.receive({ t: 'incoming', msgId: 'in-5', from: OWNER, text: `here is the code: ${IN_A_SENTENCE} thanks`, ts: 1_791_547_204 });
    await vi.waitFor(() => expect(wa.frames.filter((f) => f.t === 'send')).toHaveLength(7));
    wa.receive({ t: 'incoming', msgId: 'in-6', from: OWNER, text: 'what is running on birch?', ts: 1_791_547_205 });
    await vi.waitFor(() => expect(hubFleet.brain().join('\n')).toContain('what is running on birch?'), { timeout: 10_000 });
    const brain = hubFleet.brain().join('\n');
    expect(brain).not.toContain('here is the code');
    const replies = wa.frames.filter((f) => f.t === 'send').map((f) => String(f.text));

    const links = [replies[1], replies[5]];
    const everywhere = [
      capture.lines.join('\n'), everyRow(db), answers.join('\n'), replies.filter((text) => !links.includes(text)).join('\n'),
      JSON.stringify(tmuxCalls), brain,
    ];
    for (const text of everywhere) {
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
    expect(capture.lines.length).toBeGreaterThan(0);
  });
});
