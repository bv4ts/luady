import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewDTOSchema } from '@luady/shared';
import type { App } from '../../src/app.js';
import { ownerZone, setOwnerZone } from '@luady/shared';
import { everythingConfig, hubHeaders, keysOf, startSteps, startWiring, stopSteps, wiringCalls, wiringConfig, type WiringCalls } from './wiring-harness.js';

/**
 * The composed app equals the recorded one. expected.json is the recording, written with `RECORD_WIRING=1`;
 * its orders are for the record only: the sets and the stated constraints are compared.
 * A change that deliberately alters these sets updates expected.json in the same commit.
 */
interface Expected {
  readonly services: string[];
  readonly webDeps: string[];
  readonly toolContext: string[];
  readonly start: string[];
  readonly stop: string[];
  readonly calls: WiringCalls;
  /** With every optional service configured (Google, IMAP, phone and voice), started without listening. */
  readonly everything: { readonly start: string[]; readonly stop: string[] };
}

const EXPECTED_FILE = fileURLToPath(new URL('./expected.json', import.meta.url));
const RECORD = process.env.RECORD_WIRING === '1';

let running: App | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
  vi.restoreAllMocks();
  setOwnerZone('Etc/GMT-4');
});

async function everything(): Promise<Expected['everything']> {
  const run = await startWiring({}, everythingConfig(), false);
  running = run.app;
  await run.app.stop();
  running = null;
  return { start: startSteps(run.trace), stop: stopSteps(run.trace) };
}

async function observe(): Promise<Expected> {
  const run = await startWiring();
  running = run.app;
  const calls = await wiringCalls(run);
  await run.app.stop();
  running = null;
  return {
    everything: await everything(),
    services: Object.keys(run.app.services),
    webDeps: keysOf(run.trace, 'webDeps'),
    toolContext: keysOf(run.trace, 'toolContext'),
    start: startSteps(run.trace),
    stop: stopSteps(run.trace),
    calls,
  };
}

const sorted = (list: readonly string[]): string[] => [...list].sort();

/**
 * The calls as the website reads them: the overview through its schema, so fields added since the recording with an
 * empty default (`rooms`, `channels`, the extra server fields) compare equal to the recorded answer.
 */
const asRead = (calls: WiringCalls): WiringCalls => ({
  ...calls, overview: { ...calls.overview, body: OverviewDTOSchema.parse(calls.overview.body) },
});

describe('wire: the composed app equals the recording', () => {
  it('has the same services, WebDeps keys, tool-context keys, start and stop sets, and answers the three calls the same', async () => {
    const seen = await observe();
    if (RECORD) {
      writeFileSync(EXPECTED_FILE, `${JSON.stringify(seen, null, 2)}\n`);
      return;
    }
    const expected = JSON.parse(readFileSync(EXPECTED_FILE, 'utf8')) as Expected;
    expect(sorted(seen.services)).toEqual(sorted(expected.services));
    expect(sorted(seen.webDeps)).toEqual(sorted(expected.webDeps));
    expect(sorted(seen.toolContext)).toEqual(sorted(expected.toolContext));
    expect(sorted(seen.start)).toEqual(sorted(expected.start));
    expect(sorted(seen.stop)).toEqual(sorted(expected.stop));
    expect(asRead(seen.calls)).toEqual(asRead(expected.calls));
    expect(sorted(seen.everything.start)).toEqual(sorted(expected.everything.start));
    expect(sorted(seen.everything.stop)).toEqual(sorted(expected.everything.stop));
  });
});

const SERVERS = ['web', 'voice', 'internal'];
const FEEDS = ['activity', 'ingester'];
const LISTEN = (step: string): boolean => step.startsWith('listen.');

/** The orders the phases guarantee, on one run's start and stop steps. */
function expectPhaseOrder(start: readonly string[], stop: readonly string[]): void {
  // Start: the fleet first; the ingester and activity after every other start; listening last.
  expect(start[0]).toBe('fleet');
  const lastOther = Math.max(...start.flatMap((step, i) => (FEEDS.includes(step) || LISTEN(step) ? [] : [i])));
  for (const feed of FEEDS) expect(start.indexOf(feed), feed).toBeGreaterThan(lastOther);
  const firstListen = start.findIndex(LISTEN);
  if (firstListen !== -1) expect(start.slice(firstListen).every(LISTEN)).toBe(true);
  // Stop: the servers close before any service stops; the ingester and activity stop before every other service;
  // the fleet stops after them (only the database after it).
  const servers = stop.filter((step) => SERVERS.includes(step));
  expect(stop.slice(0, servers.length)).toEqual(servers);
  const rest = stop.slice(servers.length);
  expect(rest.slice(0, FEEDS.length)).toEqual(['ingester', 'activity']);
  expect(rest.filter((step) => step !== 'db').at(-1)).toBe('fleet');
}

describe('wire: the phases', () => {
  it('start the fleet first, the feeds after every other service and listening last; stop servers, feeds, services, fleet', async () => {
    const run = await startWiring();
    running = run.app;
    await run.app.stop();
    running = null;
    expectPhaseOrder(startSteps(run.trace), stopSteps(run.trace));
  });

  it('keep the same order with every optional service configured (Google, IMAP, the phone and its voice server)', async () => {
    const run = await startWiring({}, everythingConfig(), false);
    running = run.app;
    await run.app.stop();
    running = null;
    const stop = stopSteps(run.trace);
    expect(stop).toEqual(expect.arrayContaining(['voice', 'phone', 'imap', 'google']));
    expectPhaseOrder(startSteps(run.trace), stop);
  });
});

describe('wire: what the wiring itself does', () => {
  it('the web server listens on config.bindHost, and on 127.0.0.1 when it names none', async () => {
    const run = await startWiring();
    running = run.app;
    expect(run.listened.web).toEqual([{ host: '127.0.0.1', port: 7410 }]);
    await run.app.stop();
    const bound = await startWiring({}, wiringConfig({ bindHost: '127.0.0.2' }));
    running = bound.app;
    expect(bound.listened.web).toEqual([{ host: '127.0.0.2', port: 7410 }]);
    expect(bound.listened.internal).toEqual([{ path: expect.stringMatching(/hub\.sock$/) }]);
  });

  it('the owner zone and the manager name follow the stored settings at boot, and again after PUT /api/settings', async () => {
    setOwnerZone('Etc/GMT-4');
    const run = await startWiring({}, wiringConfig(), false, (db) => {
      db.prepare("INSERT INTO settings (key, value_json) VALUES ('owner_tz', '\"America/New_York\"')").run();
    });
    running = run.app;
    expect(ownerZone()).toBe('America/New_York');
    const me = await run.app.web.inject({ method: 'GET', url: '/api/me', headers: { 'cf-access-jwt-assertion': 'test-jwt', cookie: run.cookie, ...hubHeaders(run) } });
    const csrf = (me.json() as { csrf: string }).csrf;
    const put = await run.app.web.inject({
      method: 'PUT', url: '/api/settings', payload: { owner_tz: 'Australia/Sydney', manager_name: 'Mira' },
      headers: { 'cf-access-jwt-assertion': 'test-jwt', cookie: run.cookie, origin: run.config.publicOrigin, 'x-hub-csrf': csrf, ...hubHeaders(run) },
    });
    expect(put.statusCode).toBe(200);
    expect(ownerZone()).toBe('Australia/Sydney');
    const { managerName, setManagerName } = await import('@luady/shared');
    expect(managerName()).toBe('Mira');
    setManagerName('Luady');
  });
});
