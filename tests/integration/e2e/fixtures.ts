import { test as base, expect } from '@playwright/test';
import { PREVIEW_ROOMS } from '../../../preview/rooms-seed.ts';
import { startFakeServer, type FakeServer } from '../harness/docker.js';
import { freePort, startTestHub, type TestHub } from '../harness/hub.js';
import { WEB_DIST } from '../harness/paths.js';
import { runEnvFromProcess } from '../harness/run-env.js';
import { syncStream, waitForLog, waitForSession } from '../harness/scenario.js';
import { routeHttpsToHub } from './owner.js';

export interface E2EHub {
  hub: TestHub;
  server: FakeServer;
  baseURL: string;   // https://localhost:<port> (the hub requires an https origin; the page fixture proxies it to the plain-HTTP listener)
  port: number;
  target: string;    // cc-e2e:0.0
  sessionId: string; // cedar:cc-e2e:0.0
  sid: string;       // fake-claude session id
}

/** The classic rooms of the test hub's three servers (birch, ash, cedar), as an owner's config.rooms imports them. */
const SERVER_ROOMS = PREVIEW_ROOMS.filter((room) => room.host !== 'local');

/**
 * One in-process hub per worker, bound to localhost:<random>, with a live fake-claude session. The manager is switched
 * on (its bootstrap is skipped on the fake tmux): the office shows it and its tool route answers. Rooms
 * live in the database: the hub imports one room per server once.
 */
const withHub = base.extend<{}, { e2e: E2EHub }>({
  e2e: [
    async ({}, use) => {
      const env = runEnvFromProcess();
      const server = await startFakeServer(env);
      const port = await freePort();
      // A new install: the journeys claim it in the browser and walk the setup wizard.
      const hub = await startTestHub({ env, server, listenPort: port, webDir: WEB_DIST, manager: true, rooms: SERVER_ROOMS, setup: 'new' });
      try {
        await syncStream(hub, server);
        const target = await server.startClaude('e2e', '/home/dev/projects/e2e');
        const start = await waitForLog(server, (e) => e.kind === 'start' && e.target === target, 'fake-claude start');
        const sessionId = `cedar:${target}`;
        await waitForSession(hub, sessionId, (s) => s.state === 'idle', 'e2e session idle');
        await use({ hub, server, baseURL: `https://localhost:${port}`, port, target, sessionId, sid: String(start.sid) });
      } finally {
        await hub.stop();
        await server.down();
      }
    },
    { scope: 'worker', timeout: 300_000 },
  ],
});

/** The page goes through the https proxy to the worker's hub (owner.ts routeHttpsToHub). */
export const test = withHub.extend({
  page: async ({ page, e2e }, use) => {
    await routeHttpsToHub(page, e2e.port);
    await use(page);
  },
});

export { expect };
