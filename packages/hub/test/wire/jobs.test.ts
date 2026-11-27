import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelInfoDTO } from '@luady/shared';
import type { App } from '../../src/app.js';
import type { AccountsDeps } from '../../src/accounts/service.js';
import type { IngesterDeps } from '../../src/ingest/ingester.js';
import type { VoiceServerDeps } from '../../src/phone/server.js';
import { createWireContext } from '../../src/wire/context.js';
import { wireCore } from '../../src/wire/core.js';
import { wireFleet } from '../../src/wire/fleet.js';
import { wireWork } from '../../src/wire/work.js';
import { openMemoryDb } from '../../src/db/open.js';
import { silentLogger } from '../helpers/fakes.js';
import { everythingConfig, fixedClock, quietFleet, startWiring, wiringConfig } from './wiring-harness.js';

/** What the wire modules handed three factories. */
const seen = vi.hoisted(() => ({
  ingester: [] as IngesterDeps[],
  accounts: [] as AccountsDeps[],
  voice: [] as VoiceServerDeps[],
  hostCheck: (): boolean => true,
}));

vi.mock('../../src/ingest/ingester.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/ingest/ingester.js')>();
  return { ...real, createIngester: (deps: IngesterDeps) => (seen.ingester.push(deps), real.createIngester(deps)) };
});
vi.mock('../../src/accounts/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/accounts/service.js')>();
  return { ...real, createAccountsService: (deps: AccountsDeps) => (seen.accounts.push(deps), real.createAccountsService(deps)) };
});
vi.mock('../../src/phone/server.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/phone/server.js')>();
  return { ...real, createVoiceServer: (deps: VoiceServerDeps) => (seen.voice.push(deps), real.createVoiceServer(deps)) };
});
vi.mock('../../src/web/host-check.js', () => ({ createHostCheck: () => seen.hostCheck }));

let running: App | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
  seen.ingester.length = 0;
  seen.accounts.length = 0;
  seen.voice.length = 0;
});

describe('wire: what three factories are handed', () => {
  it('the ingester tails a function of the fleet, read when it is called, never a captured list', async () => {
    let hosts = ['cedar', 'hq'];
    const fleet = { ...quietFleet(), hosts: () => hosts };
    const run = await startWiring({ fleet }, wiringConfig(), false);
    running = run.app;
    const deps = seen.ingester.at(-1);
    expect(deps?.hosts()).toEqual(['cedar', 'hq']);
    hosts = ['cedar', 'mars', 'hq'];
    expect(deps?.hosts()).toEqual(['cedar', 'mars', 'hq']);
  });

  it('the voice server is built with the Host check of web/host-check.ts', async () => {
    const run = await startWiring({}, everythingConfig(), false);
    running = run.app;
    expect(seen.voice).toHaveLength(1);
    expect(seen.voice[0]?.hostCheck).toBe(seen.hostCheck);
  });

  it('accounts read the declared channels at call time, even when `channels` is provided after accounts are wired', () => {
    const ctx = createWireContext(wiringConfig(), { db: openMemoryDb(), log: silentLogger(), clock: fixedClock, fleet: quietFleet() });
    wireCore(ctx);
    wireFleet(ctx);
    wireWork(ctx);
    const deps = seen.accounts.at(-1);
    const info: ChannelInfoDTO = {
      id: 'test-channel', kind: 'channel', name: 'Test', state: 'up', detail: null, since: null, primary: true, capabilities: null, panel: null,
    };
    ctx.provide('channels', { list: () => [info] });
    expect(deps?.channels?.()).toEqual([info]);
  });
});
