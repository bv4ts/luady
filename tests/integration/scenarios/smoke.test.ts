import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startFakeServer, type FakeServer } from '../harness/docker.js';
import { startTestHub, type TestHub } from '../harness/hub.js';
import { syncStream } from '../harness/scenario.js';
import { sleep, waitFor } from '../harness/wait.js';

let server: FakeServer;
let hub: TestHub;

beforeAll(async () => {
  server = await startFakeServer(inject('luadyIt'));
  hub = await startTestHub({ env: inject('luadyIt'), server });
});

afterAll(async () => {
  await hub?.stop();
  await server?.down();
});

describe('harness smoke', () => {
  it('reaches the fake server over SSH with the pinned host key and runs luady-ctl', async () => {
    const client = hub.app.services.fleet.client('cedar');
    const version = await waitFor(() => client.version().catch(() => undefined), { timeoutMs: 60_000, what: 'luady-ctl version on cedar' });
    expect(version.claude).toContain('2.1.295');
    expect(version.python).toMatch(/^3\.12/);
    expect(version.tmux).toMatch(/^3[.]4/);
    await waitFor(() => hub.app.services.fleet.servers().find((s) => s.name === 'cedar' && s.status === 'online'), { what: 'cedar online' });
  });

  it('ingests hook events written on the server (the event stream is live)', async () => {
    await syncStream(hub, server);
  });

  it('refuses to run anything on a server whose host key does not match the pin', async () => {
    const wrong = await startTestHub({ env: inject('luadyIt'), server, hostKeyFp: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    try {
      const outcome = await Promise.race([
        wrong.app.services.fleet.client('cedar').version().then(() => 'ran', () => 'refused'),
        sleep(20_000).then(() => 'refused'),
      ]);
      expect(outcome).toBe('refused');
      expect(wrong.app.services.fleet.servers().find((s) => s.name === 'cedar')?.status).not.toBe('online');
    } finally {
      await wrong.stop();
    }
  });
});
